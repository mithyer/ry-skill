import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import lockfile from "proper-lockfile";

import type { ActivePipelineReservation, StageAccess } from "./types.ts";
import { CoordinatorStore } from "./coordinator-store.ts";

/** One durable reservation-ledger event. */
export interface ReservationEvent {
	/** Ledger schema version. */
	schemaVersion: 1;
	/** Monotonic physical sequence. */
	seq: number;
	/** Stable idempotency identity. */
	eventId: string;
	/** Reservation lifecycle event kind. */
	type: "intent" | "commit" | "heartbeat" | "release" | "reconcile";
	/** Workspace reservation identity. */
	reservationId: string;
	/** Reservation epoch used to fence stale writers. */
	reservationEpoch: number;
	/** Pipeline owning the reservation. */
	pipelineId: string;
	/** Stable stage identity, when the reservation is stage-scoped. */
	stageId?: string;
	/** Stage attempt represented by the reservation. */
	attempt?: number;
	/** Fencing token represented by the reservation. */
	fencingToken?: string;
	/** Number of coordinator worker slots claimed. */
	reservedSlots: number;
	/** Access mode used for resource conflict checks. */
	access: StageAccess;
	/** Canonical resources held by the reservation. */
	resourceKeys: readonly string[];
	/** Coordinator owner epoch. */
	ownerEpoch: string;
	/** UTC event timestamp. */
	timestamp: string;
	/** Last durable heartbeat timestamp. */
	lastHeartbeatAt?: string;
	/** Lease expiration timestamp when a heartbeat carries an updated TTL. */
	expiresAt?: string;
}

/** Reservation claim input validated before the ledger lock is acquired. */
export interface ReservationClaim {
	/** Stable reservation identity; generated when omitted. */
	reservationId?: string;
	/** Pipeline identity. */
	pipelineId: string;
	/** Stable stage identity. */
	stageId?: string;
	/** Attempt number. */
	attempt?: number;
	/** Fencing token. */
	fencingToken?: string;
	/** Worker slots to reserve; direct leaf reservations use zero. */
	reservedSlots: number;
	/** Lease expiration captured at claim time. */
	expiresAt?: string;
	/** Resource access mode. */
	access: StageAccess;
	/** Canonical resources to lock. */
	resourceKeys: readonly string[];
	/** Coordinator owner epoch. */
	ownerEpoch: string;
}

/** Replay projection for a reservation and its lease state. */
export interface ReservationProjection extends ReservationClaim {
	/** Stable reservation identity. */
	reservationId: string;
	/** Reservation epoch. */
	reservationEpoch: number;
	/** Durable lifecycle state. */
	state: "intent" | "active" | "released" | "orphan-pending";
	/** UTC claim timestamp. */
	acquiredAt: string;
	/** Lease expiration timestamp. */
	expiresAt?: string;
	/** Last heartbeat timestamp. */
	lastHeartbeatAt?: string;
	/** Physical release sequence. */
	releaseSequence?: number;
}

/** Result of a bounded resource/slot claim transaction. */
export interface ReservationClaimResult {
	/** Whether the reservation was committed. */
	committed: boolean;
	/** Durable projection when committed or idempotently reused. */
	reservation?: ReservationProjection;
	/** Fail-closed conflict reason. */
	reason?: "quota" | "resource-conflict" | "duplicate" | "invalid";
}

/** Workspace-scoped durable reservation ledger and shared resource conflict lock. */
export class WorkspaceReservationLedger {
	/** Coordinator store supplies the workspace-isolated ledger path and sidecar lock. */
	private readonly coordinatorStore: CoordinatorStore;
	/** Active lease TTL used when callers do not provide a deadline. */
	private readonly leaseTtlMs: number;
	/** Clock seam used by race and expiry tests. */
	private readonly now: () => Date;

	/**
	 * Creates a workspace ledger bound to one project/workspace pair.
	 *
	 * @param projectRoot Project root containing durable `.pi` state.
	 * @param workspaceId Herdr workspace identity.
	 * @param options Optional lease clock settings.
	 */
	constructor(projectRoot: string, workspaceId: string, options: { leaseTtlMs?: number; now?: () => Date } = {}) {
		this.coordinatorStore = new CoordinatorStore(projectRoot, workspaceId);
		this.leaseTtlMs = options.leaseTtlMs ?? 600_000;
		this.now = options.now ?? (() => new Date());
	}

	/** Returns the workspace-isolated ledger path for diagnostics and tests. */
	get ledgerPath(): string {
		return this.coordinatorStore.reservationLedgerPath;
	}

	/** Ensures the ledger and its parent directories exist. */
	async ensure(): Promise<void> {
		await this.coordinatorStore.ensure();
		await ensureEmptyFile(this.ledgerPath);
	}

	/** Reads and validates every ledger line under the shared reservation lock. */
	async readEvents(): Promise<readonly ReservationEvent[]> {
		return this.withLedgerLock(async () => readLedger(this.ledgerPath));
	}

	/** Replays the ledger into active, released, and orphan-pending reservations. */
	async project(): Promise<readonly ReservationProjection[]> {
		return this.withLedgerLock(async () => projectLedger(await readLedger(this.ledgerPath), this.now()));
	}

	/** Returns active worker slots and resource leases from the authoritative ledger. */
	async active(): Promise<readonly ReservationProjection[]> {
		return (await this.project()).filter((item) => item.state === "active" || item.state === "intent" || item.state === "orphan-pending");
	}

	/** Atomically appends intent and commit after quota/resource conflict checks. */
	async claim(input: ReservationClaim, limits: { maxAgents?: number } = {}): Promise<ReservationClaimResult> {
		validateClaim(input);
		return this.withLedgerLock(async () => {
			const events = await readLedger(this.ledgerPath);
			const projections = projectLedger(events, this.now());
			const reservationId = input.reservationId ?? `reservation-${randomUUID()}`;
			const existing = projections.find((item) => item.reservationId === reservationId);
			if (existing) {
				if (!sameClaim(existing, { ...input, reservationId })) return { committed: false, reason: "duplicate" };
				return { committed: existing.state === "active", reservation: existing };
			}
			const active = projections.filter((item) => item.state === "active" || item.state === "intent" || item.state === "orphan-pending");
			const maxAgents = limits.maxAgents ?? Number.MAX_SAFE_INTEGER;
			const usedSlots = active.reduce((sum, item) => sum + item.reservedSlots, 0);
			if (usedSlots + input.reservedSlots > maxAgents) return { committed: false, reason: "quota" };
			const conflict = active.find((item) => resourcesConflict(item, input));
			if (conflict) return { committed: false, reason: "resource-conflict" };
			const now = this.now();
			const reservationEpoch = nextReservationEpoch(active, input.pipelineId);
			const base: ReservationEvent = {
				schemaVersion: 1,
				seq: events.length + 1,
				eventId: `${reservationId}-intent`,
				type: "intent",
				reservationId,
				reservationEpoch,
				pipelineId: input.pipelineId,
				...(input.stageId ? { stageId: input.stageId } : {}),
				...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
				...(input.fencingToken ? { fencingToken: input.fencingToken } : {}),
				reservedSlots: input.reservedSlots,
				...(input.expiresAt ? { expiresAt: input.expiresAt } : { expiresAt: new Date(now.getTime() + this.leaseTtlMs).toISOString() }),
				access: input.access,
				resourceKeys: [...input.resourceKeys],
				ownerEpoch: input.ownerEpoch,
				timestamp: now.toISOString(),
			};
			await appendLedger(this.ledgerPath, base);
			try {
				const commit: ReservationEvent = { ...base, seq: base.seq + 1, eventId: `${reservationId}-commit`, type: "commit" };
				await appendLedger(this.ledgerPath, commit);
			} catch (error) {
				// A failed commit leaves an intent; reconcile that intent immediately when the append boundary remains writable.
				try {
					const currentEvents = await readLedger(this.ledgerPath);
					await appendLedger(this.ledgerPath, {
						...base,
						seq: currentEvents.length + 1,
						eventId: `${reservationId}-reconcile-${currentEvents.length + 1}`,
						type: "reconcile",
					});
				} catch {
					// The expiring intent remains visible for the next locked reconciliation pass.
				}
				throw error;
			}
			const reservation = projectLedger(await readLedger(this.ledgerPath), this.now()).find((item) => item.reservationId === reservationId);
			if (!reservation) throw new Error(`reservation ${reservationId} disappeared after commit`);
			return { committed: true, reservation };
		});
	}

	/** Renews a lease only when its reservation and fencing identity remain current. */
	async heartbeat(reservationId: string, ownerEpoch: string, expiresAt?: string): Promise<boolean> {
		return this.withLedgerLock(async () => {
			const events = await readLedger(this.ledgerPath);
			const current = projectLedger(events, this.now()).find((item) => item.reservationId === reservationId);
			if (!current || current.state !== "active" || current.ownerEpoch !== ownerEpoch) return false;
			const timestamp = this.now().toISOString();
			await appendLedger(this.ledgerPath, {
				schemaVersion: 1,
				seq: events.length + 1,
				eventId: `${reservationId}-heartbeat-${events.length + 1}`,
				type: "heartbeat",
				reservationId,
				reservationEpoch: current.reservationEpoch,
				pipelineId: current.pipelineId,
				...(current.stageId ? { stageId: current.stageId } : {}),
				...(current.attempt !== undefined ? { attempt: current.attempt } : {}),
				...(current.fencingToken ? { fencingToken: current.fencingToken } : {}),
				reservedSlots: current.reservedSlots,
				...(current.expiresAt ? { expiresAt: current.expiresAt } : {}),
				access: current.access,
				resourceKeys: current.resourceKeys,
				ownerEpoch,
				timestamp,
				lastHeartbeatAt: timestamp,
				...(expiresAt ? { expiresAt } : {}),
			});
			return true;
		});
	}

	/** Releases one reservation only when the owner/fence still matches. */
	async release(reservationId: string, ownerEpoch: string, fencingToken?: string): Promise<boolean> {
		return this.withLedgerLock(async () => {
			const events = await readLedger(this.ledgerPath);
			const current = projectLedger(events, this.now()).find((item) => item.reservationId === reservationId);
			if (!current || current.state === "released" || current.ownerEpoch !== ownerEpoch || (fencingToken !== undefined && current.fencingToken !== fencingToken)) return false;
			await appendLedger(this.ledgerPath, {
				schemaVersion: 1,
				seq: events.length + 1,
				eventId: `${reservationId}-release`,
				type: "release",
				reservationId,
				reservationEpoch: current.reservationEpoch,
				pipelineId: current.pipelineId,
				...(current.stageId ? { stageId: current.stageId } : {}),
				...(current.attempt !== undefined ? { attempt: current.attempt } : {}),
				...(current.fencingToken ? { fencingToken: current.fencingToken } : {}),
				reservedSlots: current.reservedSlots,
				...(current.expiresAt ? { expiresAt: current.expiresAt } : {}),
				access: current.access,
				resourceKeys: current.resourceKeys,
				ownerEpoch,
				timestamp: this.now().toISOString(),
			});
			return true;
		});
	}

	/** Reconciles orphaned reservations only when the caller proves the fence is gone. */
	async reconcile(validReservationIds: ReadonlySet<string>): Promise<readonly ReservationProjection[]> {
		return this.withLedgerLock(async () => {
			const events = await readLedger(this.ledgerPath);
			const projections = projectLedger(events, this.now());
			for (const item of projections) {
				if (item.pipelineId.startsWith("direct-")) continue;
				if ((item.state === "active" || item.state === "intent" || item.state === "orphan-pending") && !validReservationIds.has(item.reservationId)) {
					// An expired or uncommitted reservation with no matching durable stage is safe to reconcile; proven active reservations remain fail-closed.
					await appendLedger(this.ledgerPath, {
						schemaVersion: 1,
						seq: (await readLedger(this.ledgerPath)).length + 1,
						eventId: `${item.reservationId}-reconcile`,
						type: "reconcile",
						reservationId: item.reservationId,
						reservationEpoch: item.reservationEpoch,
						pipelineId: item.pipelineId,
						...(item.stageId ? { stageId: item.stageId } : {}),
						...(item.attempt !== undefined ? { attempt: item.attempt } : {}),
						...(item.fencingToken ? { fencingToken: item.fencingToken } : {}),
						reservedSlots: item.reservedSlots,
						...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
						access: item.access,
						resourceKeys: item.resourceKeys,
						ownerEpoch: item.ownerEpoch,
						timestamp: this.now().toISOString(),
					});
				}
			}
			return projectLedger(await readLedger(this.ledgerPath), this.now());
		});
	}

	/** Runs a callback while holding the workspace reservation sidecar lock. */
	private async withLedgerLock<T>(callback: () => Promise<T>): Promise<T> {
		await this.ensure();
		const release = await lockfile.lock(this.ledgerPath, { realpath: false, stale: 10_000, retries: { retries: 20, minTimeout: 10, maxTimeout: 250, factor: 1.5 } });
		try {
			return await callback();
		} finally {
			await release();
		}
	}
}

/** Resolves a cwd to a stable canonical resource key, including nonexistent tails. */
export async function canonicalCwdResourceKey(cwd: string): Promise<string | undefined> {
	if (typeof cwd !== "string" || !cwd.trim()) return undefined;
	let candidate = resolve(cwd);
	const tail: string[] = [];
	while (true) {
		try {
			const canonical = await realpath(candidate);
			return `cwd:${canonical}${tail.length > 0 ? `/${tail.reverse().join("/")}` : ""}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			const parent = resolve(candidate, "..");
			if (parent === candidate) return undefined;
			tail.push(candidate.slice(parent.length + 1));
			candidate = parent;
		}
	}
}

/** Validates reservation claims before they can enter the durable ledger. */
function validateClaim(input: ReservationClaim): void {
	if (!input.pipelineId.trim() || !input.ownerEpoch.trim()) throw new Error("reservation pipelineId and ownerEpoch are required");
	if (!Number.isSafeInteger(input.reservedSlots) || input.reservedSlots < 0) throw new Error("reservation reservedSlots must be a non-negative safe integer");
	if (!input.resourceKeys.length) throw new Error("reservation resourceKeys are required");
	if (new Set(input.resourceKeys).size !== input.resourceKeys.length) throw new Error("reservation resourceKeys must be unique");
}

/** Determines whether two active reservations conflict under the access matrix. */
function resourcesConflict(left: ReservationProjection, right: ReservationClaim): boolean {
	if (left.resourceKeys.length === 0 || right.resourceKeys.length === 0) return true;
	if (!left.resourceKeys.some((key) => right.resourceKeys.includes(key))) return false;
	return !(left.access === "read-only" && right.access === "read-only");
}

/** Compares replayed identity fields for idempotent duplicate claims. */
function sameClaim(left: ReservationProjection, right: ReservationClaim): boolean {
	return left.pipelineId === right.pipelineId
		&& left.stageId === right.stageId
		&& left.attempt === right.attempt
		&& left.fencingToken === right.fencingToken
		&& left.reservedSlots === right.reservedSlots
		&& left.expiresAt === right.expiresAt
		&& left.access === right.access
		&& JSON.stringify(left.resourceKeys) === JSON.stringify(right.resourceKeys)
		&& left.ownerEpoch === right.ownerEpoch;
}

/** Calculates a monotonic epoch for one pipeline's new reservation wave. */
function nextReservationEpoch(active: readonly ReservationProjection[], pipelineId: string): number {
	return Math.max(0, ...active.filter((item) => item.pipelineId === pipelineId).map((item) => item.reservationEpoch)) + 1;
}

/** Replays the append-only ledger with intent/commit/release semantics. */
function projectLedger(events: readonly ReservationEvent[], now: Date): ReservationProjection[] {
	const projections = new Map<string, ReservationProjection>();
	for (const event of events) {
		const previous = projections.get(event.reservationId);
		if (event.type === "intent") {
			projections.set(event.reservationId, {
			reservationId: event.reservationId,
			pipelineId: event.pipelineId,
			...(event.stageId ? { stageId: event.stageId } : {}),
			...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
			...(event.fencingToken ? { fencingToken: event.fencingToken } : {}),
			reservedSlots: event.reservedSlots,
			...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
			access: event.access,
			resourceKeys: [...event.resourceKeys],
			ownerEpoch: event.ownerEpoch,
			reservationEpoch: event.reservationEpoch,
			state: "intent",
			acquiredAt: event.timestamp,
		});
			continue;
		}
		if (!previous) continue;
		if (event.reservationEpoch !== previous.reservationEpoch) continue;
		if (event.type === "commit") previous.state = "active";
		if (event.type === "heartbeat") {
			previous.lastHeartbeatAt = event.lastHeartbeatAt ?? event.timestamp;
			previous.expiresAt = event.expiresAt ?? new Date(now.getTime() + 600_000).toISOString();
		}
		if (event.type === "release" || event.type === "reconcile") {
			previous.state = "released";
			previous.releaseSequence = event.seq;
		}
	}
	for (const projection of projections.values()) {
		if ((projection.state === "active" || projection.state === "intent") && projection.expiresAt && Date.parse(projection.expiresAt) <= now.getTime()) projection.state = "orphan-pending";
	}
	return [...projections.values()];
}

/** Reads and validates the complete reservation JSONL file. */
async function readLedger(file: string): Promise<ReservationEvent[]> {
	const text = await readFile(file, "utf8");
	if (!text) return [];
	if (!text.endsWith("\n")) throw new Error(`Reservation ledger has an incomplete final line: ${file}`);
	return text.trimEnd().split("\n").map((line, index) => {
		let value: unknown;
		try { value = JSON.parse(line); } catch { throw new Error(`Reservation ledger line ${index + 1} is invalid JSON: ${file}`); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Reservation ledger line ${index + 1} is not an object: ${file}`);
		const event = value as ReservationEvent;
		if (event.schemaVersion !== 1 || event.seq !== index + 1 || typeof event.eventId !== "string" || typeof event.reservationId !== "string" || !["intent", "commit", "heartbeat", "release", "reconcile"].includes(event.type)) throw new Error(`Reservation ledger line ${index + 1} has invalid identity: ${file}`);
		return event;
	});
}

/** Appends one reservation event and verifies its physical sequence. */
async function appendLedger(file: string, event: ReservationEvent): Promise<void> {
	await writeFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
}

/** Ensures a lockable file exists without overwriting another process's file. */
async function ensureEmptyFile(file: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	try { await stat(file); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	try { const handle = await open(file, "wx"); await handle.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
