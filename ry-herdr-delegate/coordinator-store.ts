import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import lockfile from "proper-lockfile";

import type { ActivePipelineReservation, AgentTransportStatus, CoordinatorBinding } from "./types.ts";

/** Binding persistence options shared by coordinator creation and recovery. */
export interface CoordinatorStoreOptions {
	/** Sidecar lock stale threshold in milliseconds. */
	staleMs?: number;
	/** Number of lock acquisition retries. */
	retries?: number;
}

/** Creates a durable coordinator store rooted at one project/workspace pair. */
export class CoordinatorStore {
	/** Project root used to resolve all state paths. */
	readonly projectRoot: string;
	/** Herdr workspace identity used to isolate coordinator bindings. */
	readonly workspaceId: string;
	/** Directory containing binding and pipeline state. */
	readonly stateDirectory: string;
	/** Binding JSON path. */
	readonly bindingPath: string;
	/** Durable inbox JSONL path. */
	readonly inboxPath: string;
	/** Sidecar path used to serialize short coordinator claim/commit sections. */
	readonly executionLockPath: string;
	/** Workspace-scoped reservation ledger JSONL path. */
	readonly reservationLedgerPath: string;
	/** Sidecar lock serializing pane layout mutations. */
	readonly layoutLockPath: string;
	/** Sidecar lock serializing shared resource claims. */
	readonly resourceLockPath: string;
	/** Lock configuration. */
	private readonly options: CoordinatorStoreOptions;

	/**
	 * Creates a project/workspace-bound coordinator store.
	 *
	 * @param projectRoot Project root whose `.pi` state is owned by this store.
	 * @param workspaceId Herdr workspace identifier.
	 * @param options Lock retry and stale settings.
	 */
	constructor(projectRoot: string, workspaceId: string, options: CoordinatorStoreOptions = {}) {
		if (!workspaceId.trim()) throw new Error("Coordinator workspaceId must be non-empty");
		this.projectRoot = projectRoot;
		this.workspaceId = workspaceId;
		this.stateDirectory = join(projectRoot, ".pi", "agent", "ry-herdr-delegate", "workspaces", workspaceDirectoryName(workspaceId));
		this.bindingPath = join(this.stateDirectory, "pipeline-coordinator.json");
		this.inboxPath = join(this.stateDirectory, "pipelines", "inbox.jsonl");
		this.executionLockPath = join(this.stateDirectory, "pipeline-coordinator.tick.lock");
		this.reservationLedgerPath = join(this.stateDirectory, "reservations.jsonl");
		this.layoutLockPath = join(this.stateDirectory, "workspace-layout.lock");
		this.resourceLockPath = join(this.stateDirectory, "workspace-resources.lock");
		this.options = options;
	}

	/** Ensures binding and inbox parent directories/files exist before locking. */
	async ensure(): Promise<void> {
		await mkdir(dirname(this.bindingPath), { recursive: true });
		await mkdir(dirname(this.inboxPath), { recursive: true });
		await ensureEmptyFile(this.bindingPath);
		await ensureEmptyFile(this.inboxPath);
		await ensureEmptyFile(this.executionLockPath);
		await ensureEmptyFile(this.reservationLedgerPath);
		await ensureEmptyFile(this.layoutLockPath);
		await ensureEmptyFile(this.resourceLockPath);
	}

	/** Reads and validates the current binding, returning undefined for an unbound project. */
	async read(): Promise<CoordinatorBinding | undefined> {
		await this.ensure();
		const text = await readFile(this.bindingPath, "utf8");
		if (!text.trim()) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			throw new Error(`Coordinator binding is not valid JSON: ${this.bindingPath}`);
		}
		return validateBinding(value, this.projectRoot, this.workspaceId, this.bindingPath);
	}

	/** Runs a callback while holding the binding sidecar lock. */
	async withLock<T>(callback: () => Promise<T>): Promise<T> {
		await this.ensure();
		const release = await lockfile.lock(this.bindingPath, {
			realpath: false,
			stale: Math.max(this.options.staleMs ?? 10000, 2000),
			retries: {
				retries: this.options.retries ?? 20,
				minTimeout: 10,
				maxTimeout: 250,
				factor: 1.5,
			},
		});
		try {
			return await callback();
		} finally {
			await release();
		}
	}

	/** Runs a callback while holding the coordinator execution lock.
	 *
	 * @param callback One serialized coordinator tick operation.
	 * @returns The callback result after the lock is released.
	 */
	async withExecutionLock<T>(callback: () => Promise<T>): Promise<T> {
		await this.ensure();
		const release = await lockfile.lock(this.executionLockPath, {
			realpath: false,
			stale: Math.max(this.options.staleMs ?? 10000, 2000),
			retries: {
				retries: this.options.retries ?? 20,
				minTimeout: 10,
				maxTimeout: 250,
				factor: 1.5,
			},
		});
		try {
			return await callback();
		} finally {
			await release();
		}
	}

	/** Runs a callback while holding the workspace pane-layout lock. */
	async withLayoutLock<T>(callback: () => Promise<T>): Promise<T> {
		return this.withPathLock(this.layoutLockPath, callback);
	}

	/** Runs a callback while holding the shared resource lock. */
	async withResourceLock<T>(callback: () => Promise<T>): Promise<T> {
		return this.withPathLock(this.resourceLockPath, callback);
	}

	/** Applies the common filesystem sidecar-lock policy to one workspace lock. */
	private async withPathLock<T>(path: string, callback: () => Promise<T>): Promise<T> {
		await this.ensure();
		const release = await lockfile.lock(path, {
			realpath: false,
			stale: Math.max(this.options.staleMs ?? 10000, 2000),
			retries: { retries: this.options.retries ?? 20, minTimeout: 10, maxTimeout: 250, factor: 1.5 },
		});
		try { return await callback(); } finally { await release(); }
	}

	/** Publishes one fully verified binding through atomic rename and read-after-write validation. */
	async write(binding: CoordinatorBinding): Promise<CoordinatorBinding> {
		validateBinding(binding, this.projectRoot, this.workspaceId, this.bindingPath);
		await this.ensure();
		const temporary = `${this.bindingPath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		try {
			await rename(temporary, this.bindingPath);
		} catch (error) {
			await import("node:fs/promises").then(({ unlink }) => unlink(temporary).catch(() => undefined));
			throw error;
		}
		const written = await this.read();
		if (!written || JSON.stringify(written) !== JSON.stringify(binding)) {
			throw new Error(`Coordinator binding read-after-write validation failed: ${this.bindingPath}`);
		}
		return written;
	}

	/** Updates the replay-derived reservation projection while preserving the coordinator writer fence.
	 *
	 * @param reservations Current active, intent, or orphan-pending leases.
	 * @param writerFence Expected coordinator writer fence.
	 * @returns The updated binding, or undefined when no binding exists.
	 */
	async updateReservations(reservations: readonly ActivePipelineReservation[], writerFence?: string): Promise<CoordinatorBinding | undefined> {
		return this.withLock(async () => {
			const current = await this.read();
			if (!current) return undefined;
			if (writerFence !== undefined && current.writerFence !== writerFence) throw new Error("Coordinator reservation projection writer fence is stale");
			return this.write({ ...current, activePipelineReservations: reservations, lastSeenAt: new Date().toISOString() });
		});
	}
	/** Updates transport metadata while the caller already owns the binding lock. */
	async updateStatus(status: AgentTransportStatus, paneId: string, lastSeenAt = new Date().toISOString()): Promise<CoordinatorBinding | undefined> {
		const current = await this.read();
		if (!current) return undefined;
		return this.write({ ...current, status, paneId, lastSeenAt });
	}

}

/** Ensures a file exists so proper-lockfile can create its sidecar directory. */
async function ensureEmptyFile(file: string): Promise<void> {
	try {
		await stat(file);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		const handle = await open(file, "wx");
		await handle.close();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/** Maps arbitrary Herdr workspace identifiers to a stable path-safe directory name. */
function workspaceDirectoryName(workspaceId: string): string {
	return `workspace-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 32)}`;
}

/** Validates binding identity and all fields needed for exact coordinator recovery. */
function validateBinding(value: unknown, projectRoot: string, workspaceId: string, source: string): CoordinatorBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Coordinator binding must be an object: ${source}`);
	const input = value as Record<string, unknown>;
	if (input.schemaVersion !== 1 && input.schemaVersion !== 2) throw new Error(`Coordinator binding schemaVersion must be 1 or 2: ${source}`);
	for (const [key, expected] of [["projectRoot", projectRoot], ["workspaceId", workspaceId]] as const) {
		if (input[key] !== expected) throw new Error(`Coordinator binding ${key} does not match current context: ${source}`);
	}
	for (const key of ["paneId", "agent", "cwd", "lastSeenAt"]) {
		if (typeof input[key] !== "string" || input[key].length === 0) throw new Error(`Coordinator binding ${key} is invalid: ${source}`);
	}
	const expectedInboxPath = join(projectRoot, ".pi", "agent", "ry-herdr-delegate", "workspaces", workspaceDirectoryName(workspaceId), "pipelines", "inbox.jsonl");
	if (input.inboxPath !== expectedInboxPath) throw new Error(`Coordinator binding inboxPath does not match current workspace: ${source}`);
	if (input.status !== "working" && input.status !== "blocked" && input.status !== "idle" && input.status !== "done" && input.status !== "unknown") {
		throw new Error(`Coordinator binding status is invalid: ${source}`);
	}
	const session = input.agentSession;
	if (!session || typeof session !== "object" || Array.isArray(session)) throw new Error(`Coordinator binding agentSession is invalid: ${source}`);
	const sessionRecord = session as Record<string, unknown>;
	for (const key of ["kind", "source", "value"]) {
		if (typeof sessionRecord[key] !== "string" || sessionRecord[key].length === 0) throw new Error(`Coordinator binding agentSession.${key} is invalid: ${source}`);
	}
	const reservations = input.activePipelineReservations;
	if (reservations !== undefined && (!Array.isArray(reservations) || reservations.some((item) => !item || typeof item !== "object" || typeof (item as Record<string, unknown>).reservationId !== "string" || typeof (item as Record<string, unknown>).pipelineId !== "string" || !Number.isSafeInteger((item as Record<string, unknown>).reservedSlots) || !Array.isArray((item as Record<string, unknown>).leaseIds) || !Number.isSafeInteger((item as Record<string, unknown>).reservationEpoch) || typeof (item as Record<string, unknown>).ownerEpoch !== "string"))) throw new Error(`Coordinator binding activePipelineReservations is invalid: ${source}`);
	if (input.schemaVersion === 2 && (typeof input.schemaEpoch !== "number" || !Number.isSafeInteger(input.schemaEpoch) || input.schemaEpoch < 1 || typeof input.writerFence !== "string" || input.writerFence.length === 0)) throw new Error(`Coordinator binding schemaVersion 2 requires schemaEpoch and writerFence: ${source}`);
	return input as unknown as CoordinatorBinding;
}
