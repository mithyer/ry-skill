import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { appendEvent, communicationIdFromPath, createEventLog, createEventLogEvent, readEventLog } from "./records.ts";
import { debug, debugError, hashDebugText } from "./debug.ts";
import type {
	ActivePipelineReservation,
	AppendedEvent,
	ConcurrencyConfig,
	CoordinatorBinding,
	EventActor,
	EventType,
	NewJsonlEvent,
	PanePolicy,
	PipelineRequest,
	PipelineStageDetailStatus,
	PipelineStageInput,
	PipelineStatus,
	PipelineSubmission,
	SessionIdentity,
	StageAccess,
} from "./types.ts";
import { isSupportedRole } from "./config.ts";
import { CoordinatorStore } from "./coordinator-store.ts";

/** Durable inbox entry containing only identifiers and event-log physical ranges. */
export interface PipelineInboxEntry {
	/** Inbox entry schema version. */
	schemaVersion: 1;
	/** Stable pipeline identity. */
	pipelineId: string;
	/** Monotonic submission sequence assigned under the inbox lock. */
	enqueueSeq: number;
	/** Absolute pipeline event-log path. */
	communicationFile: string;
	/** First event sequence/physical line containing the request. */
	messageSeq: number;
	/** First event physical line. */
	lineStart: number;
	/** Last event physical line. */
	lineEnd: number;
	/** Number of physical lines in the request event. */
	lineCount: number;
	/** Current queue transport state. */
	queueState: "queued" | "accepted" | "running" | "blocked" | "done" | "error" | "stopped";
	/** Idempotency key for the inbox entry. */
	messageId: string;
	/** UTC enqueue timestamp. */
	enqueuedAt: string;
}

/** Pipeline JSONL event log state returned by status queries. */
export interface PipelineState {
	/** Stable pipeline identity. */
	pipelineId: string;
	/** Absolute event-log path. */
	communicationFile: string;
	/** Latest derived semantic/transport status. */
	status: PipelineStatus;
	/** Latest event sequence. */
	lastSeq: number;
	/** Latest current stage information, when recorded. */
	currentStage?: string;
	/** Latest summary/error text, when recorded. */
	summary?: string;
	/** Latest coordinator accepted sequence, when available. */
	acceptedSeq?: number;
}

/** Derived state for one planned pipeline stage. */
export interface PipelineStageState {
	/** Zero-based stage position in the resolved plan. */
	stageIndex: number;
	/** Stable stage identity used for dependency and control routing. */
	stageId?: string;
	/** Stage role used for profile resolution. */
	role: string;
	/** Normalized dependency identities. */
	dependsOn?: readonly string[];
	/** Whether dependencies came from legacy omission or explicit declaration. */
	dependencyMode?: "legacy-serial" | "explicit";
	/** Resource access mode used by the replay conflict matrix. */
	access?: StageAccess;
	/** Canonical resource keys retained for replay. */
	resourceKeys?: readonly string[];
	/** Latest stage status. */
	status: PipelineStatus;
	/** Stage detail status, including wait/cancellation/fencing state. */
	detailStatus?: PipelineStageDetailStatus;
	/** Latest stage event sequence. */
	lastEventSeq: number;
	/** Latest stage result/error sequence. */
	lastOutcomeSeq: number;
	/** Answer sequence waiting to be consumed by a retry. */
	answerSeq?: number;
	/** Latest human answer text. */
	answer?: string;
	/** Recovery request sequence that authorizes a retry after an unfinished result. */
	recoverySeq?: number;
	/** Linked stage communication log. */
	communicationFile?: string;
	/** Latest stage pane. */
	paneId?: string;
	/** Latest stage agent target. */
	agent?: string;
	/** Exact stage session from the latest checkpoint/result. */
	agentSession?: SessionIdentity;
	/** Latest stage summary or blocker. */
	summary?: string;
	/** Current coordinator attempt identity. */
	attempt?: number;
	/** Current fencing token. */
	fencingToken?: string;
	/** Absolute stage deadline in UTC. */
	deadlineAt?: string;
	/** Durable reservation/lease identity. */
	reservationId?: string;
	/** Lease expiration and heartbeat metadata. */
	expiresAt?: string;
	lastHeartbeatAt?: string;
	/** Number of stale events ignored during replay. */
	staleEventCount?: number;
	/** Why this stage could not be claimed or continued. */
	blockedReason?: string;
	/** Stop/control sequence after which late results are stale. */
	cancelledSeq?: number;
}

/** Replay result used by coordinator execution and recovery. */
export interface PipelineProgress {
	/** Current pipeline state. */
	state: PipelineState;
	/** Authoritative request reconstructed from the task event. */
	request: PipelineRequest;
	/** Resolved stage state in plan order. */
	stages: readonly PipelineStageState[];
	/** Whether a durable stop request is active. */
	stopRequested: boolean;
	/** Replay projection of workspace reservations for this pipeline. */
	activePipelineReservations?: readonly ActivePipelineReservation[];
	/** Durable control actions seen during replay. */
	controlEvents?: readonly PipelineControlEvent[];
}

/** Durable pipeline control event replay projection. */
export interface PipelineControlEvent {
	/** Stable control idempotency identity. */
	controlId: string;
	/** Targeted action. */
	action: "answer" | "approve" | "reject" | "recover" | "stop";
	/** Stable target stage identities. */
	targetStageIds: readonly string[];
	/** Expected attempt/fence identity per target. */
	expected?: readonly { stageId: string; attempt?: number; fencingToken?: string }[];
	/** Pipeline writer fence captured by the control. */
	pipelineFence?: string;
	/** Event sequence. */
	seq: number;
}

/** Metadata written to the top-level event fields for stage checkpoints/results. */
export interface PipelineEventMetadata {
	/** Stage role for this event. */
	stageRole?: string;
	/** Stage occurrence for this role. */
	stageOccurrence?: number;
	/** Exact child session associated with the event. */
	agentSession?: SessionIdentity;
	/** Stage id associated with v2 stage events. */
	stageId?: string;
	/** Attempt/fencing identity associated with v2 stage events. */
	attempt?: number;
	fencingToken?: string;
	schemaVersion?: 1 | 2;
}

/** Input for one durable pipeline submission. */
export interface PipelineRequestInput {
	/** Complete task text stored in the pipeline event log. */
	task: string;
	/** Optional requested stages; coordinator validates them before execution. */
	stages?: readonly PipelineStageInput[];
	/** Requested default stage pane policy. */
	panePolicy?: "close" | "keep" | "new-tab";
	/** Optional invocation-local role/profile context. */
	context?: Record<string, unknown>;
	/** Effective concurrency policy persisted in task metadata. */
	concurrency?: ConcurrencyConfig;
	/** Config migration marker persisted in task metadata. */
	configMigration?: "v1-to-v2";
}

/** Normalizes stable stage identities and validates the dependency DAG. */
export function normalizePipelineStages(input: readonly PipelineStageInput[]): readonly PipelineStageInput[] {
	const stageIds = input.map((stage, index) => stage.stageId ?? `legacy-stage-${index}`);
	const known = new Set<string>();
	for (const stageId of stageIds) {
		if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(stageId)) throw new Error(`pipeline stageId is not stable: ${stageId}`);
		if (known.has(stageId)) throw new Error(`pipeline stageId is duplicated: ${stageId}`);
		known.add(stageId);
	}
	const normalized: PipelineStageInput[] = input.map((stage, index) => {
		// Persisted legacy plans retain their serial compatibility mode even though replayed records include normalized dependencies.
		const legacySerial = stage.dependencyMode === "legacy-serial";
		const explicit = !legacySerial && (stage.dependencyMode === "explicit" || stage.dependsOn !== undefined);
		const dependsOn = legacySerial ? (index === 0 ? [] : [stageIds[index - 1]!]) : explicit ? [...(stage.dependsOn ?? [])] : index === 0 ? [] : [stageIds[index - 1]!];
		const dependencies = new Set<string>();
		for (const dependency of dependsOn) {
			if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(dependency)) throw new Error(`pipeline stage ${stageIds[index]} has an invalid dependency identity`);
			if (dependency === stageIds[index]) throw new Error(`pipeline stage ${stageIds[index]} cannot depend on itself`);
			if (!known.has(dependency)) throw new Error(`pipeline stage ${stageIds[index]} depends on unknown stage ${dependency}`);
			if (dependencies.has(dependency)) throw new Error(`pipeline stage ${stageIds[index]} repeats dependency ${dependency}`);
			dependencies.add(dependency);
		}
		return {
			...stage,
			stageId: stageIds[index],
			dependsOn,
			dependencyMode: (explicit ? "explicit" : "legacy-serial") as "legacy-serial" | "explicit",
			access: stage.access ?? "workspace-write",
			resourceKeys: stage.resourceKeys ? [...stage.resourceKeys] : [],
		};
	});
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(normalized.map((stage) => [stage.stageId!, stage]));
	const visit = (stageId: string): void => {
		if (visited.has(stageId)) return;
		if (visiting.has(stageId)) throw new Error(`pipeline stage dependency cycle includes ${stageId}`);
		visiting.add(stageId);
		for (const dependency of byId.get(stageId)!.dependsOn ?? []) visit(dependency);
		visiting.delete(stageId);
		visited.add(stageId);
	};
	for (const stageId of stageIds) visit(stageId);
	return normalized;
}

/** Owns pipeline event logs and the single-writer durable inbox. */
export class PipelineStore {
	/** Project/workspace coordinator store. */
	readonly coordinatorStore: CoordinatorStore;
	/** Directory containing pipeline event logs. */
	readonly pipelinesDirectory: string;
	/** Durable inbox file. */
	readonly inboxPath: string;

	/**
	 * Creates a pipeline store bound to one project and Herdr workspace.
	 *
	 * @param projectRoot Project root for durable `.pi` state.
	 * @param workspaceId Herdr workspace used for coordinator isolation.
	 */
	constructor(projectRoot: string, workspaceId: string) {
		this.coordinatorStore = new CoordinatorStore(projectRoot, workspaceId);
		this.pipelinesDirectory = join(this.coordinatorStore.stateDirectory, "pipelines");
		this.inboxPath = this.coordinatorStore.inboxPath;
	}

	/** Ensures all pipeline state directories and files exist. */
	async ensure(): Promise<void> {
		await mkdir(this.pipelinesDirectory, { recursive: true });
		await this.coordinatorStore.ensure();
	}

	/** Validates an incoming request before any durable event or inbox write.
	 *
	 * @param input Untrusted pipeline request payload.
	 * @param maxStages Maximum number of resolved stages allowed by configuration.
	 * @returns The resolved stage plan used for validation.
	 * @throws When the task, context, stage shape, or stage count is invalid.
	 */
	validateRequestInput(input: PipelineRequestInput, maxStages: number): readonly PipelineStageInput[] {
		if (!input || typeof input !== "object" || typeof input.task !== "string" || !input.task.trim()) {
			throw new Error("pipeline task must be a non-empty string");
		}
		if (!Number.isSafeInteger(maxStages) || maxStages <= 0 || maxStages > 12) {
			throw new Error("pipeline maxStages must be a positive integer no greater than 12");
		}
		const panePolicy = input.panePolicy ?? "new-tab";
		parsePanePolicy(panePolicy, "pipeline.panePolicy");
		const context = input.context ?? {};
		if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("pipeline.context must be an object");
		const submittedStages = input.stages ?? [];
		if (!Array.isArray(submittedStages)) throw new Error("pipeline.stages must be an array");
		const parsedStages = submittedStages.map((value, index) => parsePipelineStage(value, `pipeline.stages[${index}]`));
		const planned = parsedStages.length > 0 ? parsedStages : [defaultPipelineStage(context as Record<string, unknown>, panePolicy)];
		const stages = normalizePipelineStages(planned);
		if (stages.length > maxStages) throw new Error(`pipeline has ${stages.length} stages; maximum is ${maxStages}`);
		validateStageLocations(this.coordinatorStore.projectRoot, stages);
		return stages;
	}

	/** Resolves one validated pipeline identifier to a path inside this workspace store.
	 *
	 * @param pipelineId Caller-supplied pipeline identifier.
	 * @returns Canonical JSONL event-log path.
	 * @throws When the identifier is not path-safe or escapes the store directory.
	 */
	private pipelinePath(pipelineId: string): string {
		if (typeof pipelineId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(pipelineId)) {
			throw new Error(`pipelineId is not path-safe: ${String(pipelineId)}`);
		}
		const root = resolve(this.pipelinesDirectory);
		const file = resolve(root, `${pipelineId}.jsonl`);
		const relativePath = relative(root, file);
		const separator = process.platform === "win32" ? "\\\\" : "/";
		if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${separator}`) || isAbsolute(relativePath)) {
			throw new Error(`pipeline path escapes workspace state: ${pipelineId}`);
		}
		return file;
	}

	/** Creates a stable pipeline JSONL event log and writes the complete request event. */
	async createRequest(input: PipelineRequestInput, pipelineId: string, transaction = pipelineId, maxStages = 12): Promise<{
		communicationFile: string;
		messageId: string;
		lineStart: number;
		lineEnd: number;
		lineCount: number;
		messageSeq: number;
	}> {
		const stages = this.validateRequestInput(input, maxStages);
		await debug.log("pipeline.request.create.start", {
			pipelineId,
			transaction,
			maxStages,
			stageCount: stages.length,
			panePolicy: input.panePolicy ?? "new-tab",
			task: { length: input.task.length, sha256: hashDebugText(input.task) },
		}, "debug");
		await this.ensure();
		const communicationFile = this.pipelinePath(pipelineId);
		await createEventLog(communicationFile);
		await appendEvent(communicationFile, createEventLogEvent(transaction, "pipeline", 1, "parent"));
		const messageId = `pipeline-task-${pipelineId}`;
		const requestEvent: NewJsonlEvent = {
			schemaVersion: 1,
			eventId: `pipeline-task-${pipelineId}`,
			messageId,
			timestamp: new Date().toISOString(),
			type: "task",
			actor: "parent",
			transaction,
			stageRole: "pipeline",
			stageOccurrence: 1,
			payload: {
				pipelineId,
				task: input.task,
				// Persist the normalized plan rather than re-deriving legacy dependencies on replay.
				stages,
				panePolicy: input.panePolicy ?? "new-tab",
				context: input.context ?? {},
				...(input.concurrency ? { concurrency: input.concurrency } : {}),
				...(input.configMigration ? { configMigration: input.configMigration } : {}),
			},
		};
		const appended = await appendEvent(communicationFile, requestEvent);
		await debug.log("pipeline.request.created", {
			pipelineId,
			communicationFile,
			messageId,
			messageSeq: appended.event.seq,
			lineStart: appended.lineStart,
			stageCount: stages.length,
		}, "debug");
		return {
			communicationFile,
			messageId,
			lineStart: appended.lineStart,
			lineEnd: appended.lineEnd,
			lineCount: appended.lineCount,
			messageSeq: appended.event.seq,
		};
	}

	/** Appends one inbox entry under the coordinator binding lock and returns its assigned sequence. */
	async enqueue(entry: Omit<PipelineInboxEntry, "enqueueSeq">): Promise<PipelineInboxEntry> {
		return this.coordinatorStore.withLock(() => this.enqueueUnlocked(entry));
	}

	/** Appends an event-log request and its inbox pointer under one workspace lock.
	 *
	 * @param input Validated pipeline request input.
	 * @param pipelineId Stable path-safe pipeline identity.
	 * @param transaction Transaction identity stored in the event log.
	 * @param maxStages Maximum normalized stage count.
	 * @returns The durable request append and matching inbox entry.
	 */
	async createRequestAndEnqueue(input: PipelineRequestInput, pipelineId: string, transaction = pipelineId, maxStages = 12): Promise<{
		request: Awaited<ReturnType<PipelineStore["createRequest"]>>;
		entry: PipelineInboxEntry;
	}> {
		return this.coordinatorStore.withLock(async () => {
			const request = await this.createRequest(input, pipelineId, transaction, maxStages);
			const entry = await this.enqueueUnlocked({
				schemaVersion: 1,
				pipelineId,
				communicationFile: request.communicationFile,
				messageSeq: request.messageSeq,
				lineStart: request.lineStart,
				lineEnd: request.lineEnd,
				lineCount: request.lineCount,
				queueState: "queued",
				messageId: request.messageId,
				enqueuedAt: new Date().toISOString(),
			});
			return { request, entry };
		});
	}

	/** Performs the inbox append while the caller owns the coordinator lock. */
	private async enqueueUnlocked(entry: Omit<PipelineInboxEntry, "enqueueSeq">): Promise<PipelineInboxEntry> {
		await debug.log("pipeline.inbox.enqueue.start", { pipelineId: entry.pipelineId, communicationFile: entry.communicationFile, messageId: entry.messageId }, "debug");
		await this.ensure();
		if (entry.communicationFile !== this.pipelinePath(entry.pipelineId)) throw new Error("Pipeline inbox communicationFile does not match pipelineId");
		const existing = await readInbox(this.inboxPath);
		const duplicate = existing.find((item) => item.messageId === entry.messageId || item.pipelineId === entry.pipelineId);
		if (duplicate) return duplicate;
		const next: PipelineInboxEntry = { ...entry, enqueueSeq: existing.length + 1 };
		await appendInboxEntry(this.inboxPath, next);
		const after = await readInbox(this.inboxPath);
		const written = after.find((item) => item.messageId === next.messageId);
		if (!written || JSON.stringify(written) !== JSON.stringify(next)) {
			throw new Error(`Pipeline inbox read-after-write validation failed: ${this.inboxPath}`);
		}
		await debug.log("pipeline.inbox.enqueued", { pipelineId: written.pipelineId, enqueueSeq: written.enqueueSeq, communicationFile: written.communicationFile, messageId: written.messageId }, "debug");
		return written;
	}


	/** Reads the FIFO inbox under its shared binding lock and repairs completed orphan requests. */
	async readInbox(): Promise<readonly PipelineInboxEntry[]> {
		return this.coordinatorStore.withLock(async () => {
			await this.ensure();
			await this.reconcileOrphanedRequests();
			return readInbox(this.inboxPath);
		});
	}

	/** Re-enqueues a fully written task log left behind by a process crash before inbox commit. */
	private async reconcileOrphanedRequests(): Promise<void> {
		const existing = await readInbox(this.inboxPath);
		const known = new Set(existing.map((entry) => entry.pipelineId));
		const files = (await readdir(this.pipelinesDirectory)).filter((file) => file.endsWith(".jsonl") && file !== "inbox.jsonl").sort();
		for (const file of files) {
			const pipelineId = file.slice(0, -".jsonl".length);
			if (known.has(pipelineId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(pipelineId)) continue;
			try {
				const snapshot = await readEventLog(join(this.pipelinesDirectory, file));
				const task = snapshot.events.find(({ event }) => event.type === "task" && event.payload.pipelineId === pipelineId);
				if (!task || !task.event.messageId) continue;
				const entry: Omit<PipelineInboxEntry, "enqueueSeq"> = {
					schemaVersion: 1,
					pipelineId,
					communicationFile: this.pipelinePath(pipelineId),
					messageSeq: task.event.seq,
					lineStart: task.line,
					lineEnd: task.line,
					lineCount: 1,
					queueState: "queued",
					messageId: task.event.messageId,
					enqueuedAt: new Date().toISOString(),
				};
				await appendInboxEntry(this.inboxPath, { ...entry, enqueueSeq: (await readInbox(this.inboxPath)).length + 1 });
				known.add(pipelineId);
			} catch {
				// Damaged or incomplete logs remain fail-closed until their owning transaction is inspected.
			}
		}
	}


	/** Appends one coordinator-owned event to a pipeline JSONL log. */
	async appendPipelineEvent(
		pipelineId: string,
		type: EventType,
		actor: EventActor,
		payload: Record<string, unknown>,
		messageId?: string,
		metadata: PipelineEventMetadata = {},
	): Promise<AppendedEvent> {
		const communicationFile = this.pipelinePath(pipelineId);
		await debug.log("pipeline.event.append.start", { pipelineId, communicationFile, type, actor, messageId, stageRole: metadata.stageRole, stageOccurrence: metadata.stageOccurrence }, "trace");
		try {
			const appended = await appendEvent(communicationFile, {
			schemaVersion: metadata.schemaVersion ?? (type === "stage-claimed" || type === "stage-started" || type === "stage-heartbeat" || type === "stage-released" || type === "pipeline.control" || type === "stale-attempt-diagnostic" || type === "stale-control-diagnostic" ? 2 : 1),
			eventId: messageId ? `${type}-${pipelineId}-${messageId}` : `${type}-${pipelineId}-${randomUUID()}`,
			...(messageId ? { messageId } : {}),
			timestamp: new Date().toISOString(),
			type,
			actor,
			transaction: pipelineId,
			stageRole: metadata.stageRole ?? "pipeline",
			stageOccurrence: metadata.stageOccurrence ?? 1,
			...(metadata.agentSession ? { agentSession: metadata.agentSession } : {}),
			payload: {
				...payload,
				...(metadata.stageId ? { stageId: metadata.stageId } : {}),
				...(metadata.attempt !== undefined ? { attempt: metadata.attempt } : {}),
				...(metadata.fencingToken ? { fencingToken: metadata.fencingToken } : {}),
			},
		});
			await debug.log("pipeline.event.appended", { pipelineId, communicationFile, type, seq: appended.event.seq, eventId: appended.event.eventId, idempotent: appended.idempotent }, "trace");
			return appended;
		} catch (error) {
			await debug.log("pipeline.event.append-failed", { pipelineId, communicationFile, type, error: debugError(error) }, "error");
			throw error;
		}
	}
	/** Reads and validates the complete pipeline task event. */
	async readRequest(pipelineId: string, maxStages: number): Promise<PipelineRequest> {
		const communicationFile = this.pipelinePath(pipelineId);
		const snapshot = await readEventLog(communicationFile);
		const taskLocated = snapshot.events.find(({ event }) => event.type === "task" && event.stageRole === "pipeline");
		if (!taskLocated) throw new Error(`Pipeline ${pipelineId} has no task event`);
		const payload = taskLocated.event.payload;
		if (payload.pipelineId !== pipelineId || typeof payload.task !== "string" || !payload.task.trim()) throw new Error(`Pipeline ${pipelineId} task event has invalid identity or task`);
		const panePolicy = parsePanePolicy(payload.panePolicy, `${pipelineId}.panePolicy`);
		if (!Array.isArray(payload.stages)) throw new Error(`Pipeline ${pipelineId} task event has invalid stages`);
		const context = payload.context;
		if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error(`Pipeline ${pipelineId} task event has invalid context`);
		const parsedStages = payload.stages.map((value, index) => parsePipelineStage(value, `${pipelineId}.stages[${index}]`));
		const planned = parsedStages.length > 0 ? parsedStages : [defaultPipelineStage(context as Record<string, unknown>, panePolicy)];
		const stages = normalizePipelineStages(planned);
		if (stages.length > maxStages) throw new Error(`Pipeline ${pipelineId} has ${stages.length} stages; maximum is ${maxStages}`);
		validateStageLocations(this.coordinatorStore.projectRoot, stages);
		return {
			pipelineId,
			task: payload.task,
			stages,
			panePolicy,
			context: context as Record<string, unknown>,
			lineStart: taskLocated.line,
			lineEnd: taskLocated.line,
			lineCount: 1,
			messageSeq: taskLocated.event.seq,
			...(payload.concurrency && typeof payload.concurrency === "object" && !Array.isArray(payload.concurrency) ? { concurrency: payload.concurrency as ConcurrencyConfig } : {}),
			...(payload.configMigration === "v1-to-v2" ? { configMigration: "v1-to-v2" as const } : {}),
		};
	}

	/** Replays pipeline state and stage progress from the authoritative event log.
	 *
	 * @param pipelineId Stable path-safe pipeline identity.
	 * @param maxStages Maximum normalized stage count.
	 * @param expectedPipelineFence Optional coordinator writer fence used to ignore stale controls.
	 * @returns Replay-derived pipeline and per-stage progress.
	 */
	async readProgress(pipelineId: string, maxStages: number, expectedPipelineFence?: string): Promise<PipelineProgress> {
		const request = await this.readRequest(pipelineId, maxStages);
		const binding = await this.coordinatorStore.read();
		const effectivePipelineFence = expectedPipelineFence ?? binding?.writerFence;
		const state = await this.readState(pipelineId, effectivePipelineFence);
		const snapshot = await readEventLog(state.communicationFile);
		const stages = request.stages.map((stage, stageIndex): PipelineStageState => ({
			stageIndex,
			stageId: stage.stageId!,
			role: stage.role,
			dependsOn: [...stage.dependsOn ?? []],
			dependencyMode: stage.dependencyMode ?? "legacy-serial",
			access: stage.access ?? "workspace-write",
			resourceKeys: [...stage.resourceKeys ?? []],
			status: "QUEUED",
			detailStatus: "QUEUED",
			lastEventSeq: request.messageSeq,
			lastOutcomeSeq: 0,
		}));
		const stageMap = new Map(stages.map((stage) => [stage.stageIndex, stage]));
		const stageIdMap = new Map<string, PipelineStageState>();
		for (const stage of stages) if (stage.stageId) stageIdMap.set(stage.stageId, stage);
		const controlEvents: PipelineControlEvent[] = [];
		let stopRequested = false;
		for (const located of snapshot.events) {
			const payload = located.event.payload;
				const stage = stageForPayload(payload, stageMap, stageIdMap);
			if (located.event.type === "pipeline.control") {
				const action = readControlAction(payload.action);
				if (!action) continue;
				if (stopRequested && action !== "stop") continue;
				const pipelineFence = typeof payload.pipelineFence === "string" ? payload.pipelineFence : undefined;
				if (effectivePipelineFence && pipelineFence && pipelineFence !== effectivePipelineFence) continue;
				const targetStageIds = Array.isArray(payload.targetStageIds) ? payload.targetStageIds.filter((item): item is string => typeof item === "string") : [];
				const controlId = typeof payload.controlId === "string" ? payload.controlId : `legacy-control-${located.event.seq}`;
				const expectedValue = payload.expected;
				const expectedValid = expectedValue === undefined || (Array.isArray(expectedValue) && expectedValue.every((item) => Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).stageId === "string" && ((item as Record<string, unknown>).attempt === undefined || Number.isSafeInteger((item as Record<string, unknown>).attempt)) && ((item as Record<string, unknown>).fencingToken === undefined || typeof (item as Record<string, unknown>).fencingToken === "string")));
				if (!expectedValid) continue;
				const expected = Array.isArray(expectedValue) ? expectedValue.filter((item): item is { stageId: string; attempt?: number; fencingToken?: string } => Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).stageId === "string") : [];
				controlEvents.push({ controlId, action, targetStageIds, expected, pipelineFence: typeof payload.pipelineFence === "string" ? payload.pipelineFence : undefined, seq: located.event.seq });
				const controlTargets = targetStageIds.length > 0 ? targetStageIds.map((id) => stageIdMap.get(id)).filter((item): item is PipelineStageState => Boolean(item)) : stage ? [stage] : stages;
				const controlMatches = controlTargets.every((target) => {
					const identity = expected.find((item) => item.stageId === target.stageId);
					return !identity || (identity.attempt === undefined || identity.attempt === target.attempt) && (identity.fencingToken === undefined || identity.fencingToken === target.fencingToken);
				});
				const expectedCoversTargets = expected.length === 0 || (controlTargets.length === expected.length && controlTargets.every((target) => expected.some((item) => item.stageId === target.stageId)));
				if (!expectedCoversTargets || !controlMatches) continue;
				if (action === "answer" && typeof payload.answer === "string") {
					for (const target of controlTargets) {
						target.answer = payload.answer;
						target.answerSeq = located.event.seq;
						target.detailStatus = "WAITING_FOR_ANSWER";
						target.status = "BLOCKED";
						target.lastEventSeq = located.event.seq;
					}
				}
				if (action === "approve") for (const target of controlTargets) { target.detailStatus = "RUNNING"; target.lastEventSeq = located.event.seq; }
				if (action === "reject") for (const target of controlTargets) { target.detailStatus = "BLOCKED"; target.status = "BLOCKED"; target.lastEventSeq = located.event.seq; }
				if (action === "recover") for (const target of controlTargets) { target.recoverySeq = located.event.seq; target.lastEventSeq = located.event.seq; }
				if (action === "stop") {
					stopRequested = true;
					const targets = targetStageIds.length > 0 ? targetStageIds.map((id) => stageIdMap.get(id)) : stages;
					for (const target of targets) {
						if (!target) continue;
						if (["QUEUED", "CLAIMED", "RUNNING"].includes(target.detailStatus ?? "")) {
							target.detailStatus = "CANCELLED";
							target.status = "STOPPED";
							target.cancelledSeq = located.event.seq;
							target.lastEventSeq = located.event.seq;
						}
					}
				}
				continue;
			}
			if (stage && stage.cancelledSeq !== undefined && located.event.seq > stage.cancelledSeq) {
				stage.staleEventCount = (stage.staleEventCount ?? 0) + 1;
				stage.detailStatus = "STALE";
				continue;
			}
			if (located.event.type === "status-changed") {
				const status = payload.status;
				if (status === "STOPPED") stopRequested = true;
				if (stage && typeof status === "string" && isPipelineStatus(status) && !isStaleStageEvent(stage, payload)) {
					stage.status = status;
					stage.detailStatus = detailStatusFor(status);
					stage.lastEventSeq = located.event.seq;
					applyStageMetadata(stage, payload, located.event.agentSession);
				}
				continue;
			}
			if (located.event.type === "continuation" && typeof payload.answer === "string") {
				if (stage) {
					stage.answer = payload.answer;
					stage.answerSeq = located.event.seq;
					stage.detailStatus = "WAITING_FOR_ANSWER";
					stage.status = "BLOCKED";
					stage.lastEventSeq = located.event.seq;
				}
				continue;
			}
			if (located.event.type === "recovery") {
				if (stage) {
					stage.recoverySeq = located.event.seq;
					stage.lastEventSeq = located.event.seq;
				}
				continue;
			}
			if (located.event.type === "stage-claimed" || located.event.type === "stage-started" || located.event.type === "stage-heartbeat" || located.event.type === "stage-released") {
				if (!stage) continue;
				if (located.event.type !== "stage-claimed" && isStaleStageEvent(stage, payload)) {
					stage.staleEventCount = (stage.staleEventCount ?? 0) + 1;
					continue;
				}
				if (located.event.type === "stage-claimed") {
					stage.attempt = readPositiveInt(payload.attempt) ?? stage.attempt;
					stage.fencingToken = typeof payload.fencingToken === "string" ? payload.fencingToken : stage.fencingToken;
					stage.reservationId = typeof payload.reservationId === "string" ? payload.reservationId : stage.reservationId;
					stage.detailStatus = "CLAIMED";
					stage.status = "RUNNING";
				}
				if (located.event.type === "stage-started") stage.detailStatus = "RUNNING";
				if (located.event.type === "stage-heartbeat") stage.lastHeartbeatAt = readString(payload.lastHeartbeatAt) ?? stage.lastHeartbeatAt;
				if (located.event.type === "stage-released") {
					stage.detailStatus = readDetailStatus(payload.detailStatus) ?? detailStatusFor(readPipelineStatus(payload.status) ?? "PARTIAL");
					stage.status = readPipelineStatus(payload.status) ?? stage.status;
				}
				stage.lastEventSeq = located.event.seq;
				applyStageMetadata(stage, payload, located.event.agentSession);
				continue;
			}
			if (located.event.type === "result" || located.event.type === "reconciliation-result" || located.event.type === "error") {
				if (!stage) continue;
				if (stage.cancelledSeq !== undefined && located.event.seq > stage.cancelledSeq) {
					stage.staleEventCount = (stage.staleEventCount ?? 0) + 1;
					stage.detailStatus = "STALE";
					continue;
				}
				if (isStaleStageEvent(stage, payload)) {
					stage.staleEventCount = (stage.staleEventCount ?? 0) + 1;
					stage.detailStatus = "STALE";
					continue;
				}
				const status = readPipelineStatus(payload.status) ?? (located.event.type === "error" ? "ERROR" : "PARTIAL");
				stage.status = status;
				stage.detailStatus = detailStatusFor(status);
				stage.lastEventSeq = located.event.seq;
				stage.lastOutcomeSeq = located.event.seq;
				applyStageMetadata(stage, payload, located.event.agentSession);
				if (typeof payload.summary === "string") stage.summary = payload.summary;
				if (typeof payload.error === "string") stage.summary = payload.error;
			}
		}
		return { state, request, stages, stopRequested, controlEvents };
	}

	/** Reads a durable pipeline event log and derives its current status.
	 *
	 * @param pipelineId Stable path-safe pipeline identity.
	 * @param expectedPipelineFence Optional coordinator writer fence used to ignore stale controls.
	 * @returns Replay-derived pipeline status.
	 */
	async readState(pipelineId: string, expectedPipelineFence?: string): Promise<PipelineState> {
		const binding = await this.coordinatorStore.read();
		const effectivePipelineFence = expectedPipelineFence ?? binding?.writerFence;
		const communicationFile = this.pipelinePath(pipelineId);
		const snapshot = await readEventLog(communicationFile);
		const taskEvent = snapshot.events.find(({ event }) => event.type === "task" && event.stageRole === "pipeline");
		const stageCount = Array.isArray(taskEvent?.event.payload.stages) ? taskEvent.event.payload.stages.length : undefined;
		let status: PipelineStatus = "QUEUED";
		let currentStage: string | undefined;
		let summary: string | undefined;
		let acceptedSeq: number | undefined;
		let stopRequested = false;
		let hasTopLevelStatus = false;
		const stageStatuses = new Map<number, PipelineStatus>();
		for (const located of snapshot.events) {
			const payload = located.event.payload;
			if (located.event.type === "accepted") {
				status = "ACCEPTED";
				acceptedSeq = located.event.seq;
			}
			if (located.event.type === "pipeline.control" && payload.action === "stop" && (!effectivePipelineFence || typeof payload.pipelineFence !== "string" || payload.pipelineFence === effectivePipelineFence)) {
				stopRequested = true;
				status = "STOPPED";
			}
			if (located.event.type === "status-changed") {
				const nextStatus = payload.status;
				if (Object.prototype.hasOwnProperty.call(payload, "stageIndex") && Number.isSafeInteger(payload.stageIndex) && typeof nextStatus === "string" && isPipelineStatus(nextStatus)) stageStatuses.set(payload.stageIndex as number, nextStatus);
				if (!Object.prototype.hasOwnProperty.call(payload, "stageIndex") && typeof nextStatus === "string" && isPipelineStatus(nextStatus)) {
					hasTopLevelStatus = true;
					status = nextStatus;
				}
				if (typeof payload.currentStage === "string") currentStage = payload.currentStage;
			}
			if (located.event.type === "result" || located.event.type === "reconciliation-result" || located.event.type === "error") {
				if (Object.prototype.hasOwnProperty.call(payload, "stageIndex") && Number.isSafeInteger(payload.stageIndex) && typeof payload.status === "string" && isPipelineStatus(payload.status)) stageStatuses.set(payload.stageIndex as number, payload.status);
				if (!Object.prototype.hasOwnProperty.call(payload, "stageIndex") && typeof payload.status === "string" && isPipelineStatus(payload.status)) {
					hasTopLevelStatus = true;
					status = payload.status;
				}
				if (typeof payload.summary === "string") summary = payload.summary;
				if (typeof payload.error === "string") summary = payload.error;
			}
		}
		if (!stopRequested && stageStatuses.size > 0 && (!hasTopLevelStatus || ["QUEUED", "ACCEPTED", "RUNNING"].includes(status))) {
			const statuses = [...stageStatuses.values()];
			if (statuses.includes("ERROR")) status = "ERROR";
			else if (statuses.includes("PARTIAL")) status = "PARTIAL";
			else if (statuses.includes("BLOCKED")) status = "BLOCKED";
			else if (stageCount !== undefined && statuses.length >= stageCount && statuses.every((item) => item === "DONE")) status = "DONE";
			else if (statuses.some((item) => item === "RUNNING" || item === "ACCEPTED")) status = "RUNNING";
		}
		return { pipelineId, communicationFile, status: stopRequested ? "STOPPED" : status, lastSeq: snapshot.events.at(-1)?.event.seq ?? 0, currentStage, summary, acceptedSeq };
	}

	/** Builds the parent-visible submission response from a verified binding. */
	submission(entry: PipelineInboxEntry, binding: CoordinatorBinding, status: PipelineStatus = "QUEUED", error?: string): PipelineSubmission {
		return {
			status,
			pipelineId: entry.pipelineId,
			communicationFile: entry.communicationFile,
			coordinator: {
				paneId: binding.paneId,
				agent: binding.agent,
				agentSession: binding.agentSession,
				workspaceId: binding.workspaceId,
			},
			...(error ? { error } : {}),
		};
	}
}

/** Resolves a single default worker stage from submitted context. */
function defaultPipelineStage(context: Record<string, unknown>, panePolicy: PanePolicy): PipelineStageInput {
	const role = typeof context.role === "string" && context.role.trim() ? context.role : "worker";
	if (!isSupportedRole(role)) throw new Error(`pipeline default stage role is not configured or supported: ${role}`);
	const agent = context.agent === "codex" || context.agent === "claude" || context.agent === "pi" ? context.agent : undefined;
	const effort = typeof context.effort === "string" && context.effort.trim() ? context.effort : undefined;
	const extraArgs = Array.isArray(context.extraArgs) && context.extraArgs.every((item) => typeof item === "string") ? context.extraArgs as string[] : undefined;
	const timeoutMs = typeof context.timeoutMs === "number" && Number.isSafeInteger(context.timeoutMs) && context.timeoutMs > 0 ? context.timeoutMs : undefined;
	const cwd = typeof context.cwd === "string" && context.cwd.trim() ? context.cwd : undefined;
	return { role, ...(agent ? { agent } : {}), ...(effort ? { effort } : {}), ...(extraArgs ? { extraArgs } : {}), ...(cwd ? { cwd } : {}), ...(timeoutMs ? { timeoutMs } : {}), panePolicy };
}

/** Validates stage cwd and cwd resource declarations against the project root. */
function validateStageLocations(projectRootValue: string, stages: readonly PipelineStageInput[]): void {
	const projectRoot = resolve(projectRootValue);
	for (const stage of stages) {
		if (stage.cwd) {
			const stagePath = resolve(projectRoot, stage.cwd);
			const relativeStage = relative(projectRoot, stagePath);
			if (relativeStage === ".." || relativeStage.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`) || isAbsolute(relativeStage)) throw new Error(`pipeline stage cwd must remain inside the project root: ${stage.cwd}`);
		}
		for (const key of stage.resourceKeys ?? []) if (key.startsWith("cwd:")) {
			const resourcePath = resolve(projectRoot, key.slice("cwd:".length));
			const relativeResource = relative(projectRoot, resourcePath);
			if (relativeResource === ".." || relativeResource.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`) || isAbsolute(relativeResource)) throw new Error(`pipeline cwd resource must remain inside the project root: ${key}`);
		}
	}
}

/** Validates a pipeline pane policy from an event payload. */
function parsePanePolicy(value: unknown, path: string): PanePolicy {
	if (value !== "close" && value !== "keep" && value !== "new-tab") throw new Error(`${path} must be close, keep, or new-tab`);
	return value;
}

/** Validates one pipeline stage without coercing unknown values. */
function parsePipelineStage(value: unknown, path: string): PipelineStageInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	const input = value as Record<string, unknown>;
	const allowed = new Set(["stageId", "role", "task", "agent", "effort", "extraArgs", "cwd", "timeoutMs", "panePolicy", "dependsOn", "access", "resourceKeys", "failFast", "maxConcurrentStages", "dependencyMode"]);
	for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`${path}.${key} is an unknown field`);
	if (input.stageId !== undefined && (typeof input.stageId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(input.stageId))) throw new Error(`${path}.stageId must be a stable identifier`);
	if (typeof input.role !== "string" || !input.role.trim()) throw new Error(`${path}.role must be a non-empty string`);
	if (!isSupportedRole(input.role)) throw new Error(`${path}.role is not configured or supported`);
	if (input.task !== undefined && (typeof input.task !== "string" || !input.task.trim())) throw new Error(`${path}.task must be a non-empty string`);
	if (input.agent !== undefined && input.agent !== "codex" && input.agent !== "claude" && input.agent !== "pi") throw new Error(`${path}.agent is unsupported`);
	if (input.effort !== undefined && typeof input.effort !== "string") throw new Error(`${path}.effort must be a string`);
	if (input.extraArgs !== undefined && (!Array.isArray(input.extraArgs) || input.extraArgs.some((item) => typeof item !== "string"))) throw new Error(`${path}.extraArgs must be an array of strings`);
	if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.trim())) throw new Error(`${path}.cwd must be a non-empty string`);
	if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)) throw new Error(`${path}.timeoutMs must be a positive safe integer`);
	if (input.panePolicy !== undefined) parsePanePolicy(input.panePolicy, `${path}.panePolicy`);
	if (input.dependsOn !== undefined && (!Array.isArray(input.dependsOn) || input.dependsOn.some((item) => typeof item !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(item)))) throw new Error(`${path}.dependsOn must be an array of stable stage ids`);
	if (input.access !== undefined && input.access !== "read-only" && input.access !== "workspace-write" && input.access !== "external-side-effect") throw new Error(`${path}.access is unsupported`);
	if (input.resourceKeys !== undefined && (!Array.isArray(input.resourceKeys) || input.resourceKeys.some((item) => typeof item !== "string" || !item.trim() || (item.startsWith("cwd:") ? !isAbsolute(item.slice("cwd:".length)) : !/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(item))))) throw new Error(`${path}.resourceKeys must use canonical cwd: or namespaced resource: keys`);
	if (input.failFast !== undefined && typeof input.failFast !== "boolean") throw new Error(`${path}.failFast must be a boolean`);
	if (input.maxConcurrentStages !== undefined && (typeof input.maxConcurrentStages !== "number" || !Number.isSafeInteger(input.maxConcurrentStages) || input.maxConcurrentStages <= 0)) throw new Error(`${path}.maxConcurrentStages must be a positive safe integer`);
	if (input.dependencyMode !== undefined && input.dependencyMode !== "legacy-serial" && input.dependencyMode !== "explicit") throw new Error(`${path}.dependencyMode is unsupported`);
	return {
		...(input.stageId !== undefined ? { stageId: input.stageId as string } : {}),
		role: input.role,
		...(input.task !== undefined ? { task: input.task } : {}),
		...(input.agent !== undefined ? { agent: input.agent } : {}),
		...(input.effort !== undefined ? { effort: input.effort } : {}),
		...(input.extraArgs !== undefined ? { extraArgs: input.extraArgs as string[] } : {}),
		...(input.cwd !== undefined ? { cwd: input.cwd as string } : {}),
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs as number } : {}),
		...(input.panePolicy !== undefined ? { panePolicy: input.panePolicy as PanePolicy } : {}),
		...(input.dependsOn !== undefined ? { dependsOn: [...input.dependsOn as string[]] } : {}),
		...(input.access !== undefined ? { access: input.access as StageAccess } : {}),
		...(input.resourceKeys !== undefined ? { resourceKeys: [...input.resourceKeys as string[]] } : {}),
		...(input.failFast !== undefined ? { failFast: input.failFast as boolean } : {}),
		...(input.maxConcurrentStages !== undefined ? { maxConcurrentStages: input.maxConcurrentStages as number } : {}),
		...(input.dependencyMode !== undefined ? { dependencyMode: input.dependencyMode as "legacy-serial" | "explicit" } : {}),
	};
}

/** Reads a stage index from a structured pipeline event payload. */
function readStageIndex(payload: Record<string, unknown>): number | undefined {
	return Number.isSafeInteger(payload.stageIndex) && (payload.stageIndex as number) >= 0 ? payload.stageIndex as number : undefined;
}

/** Resolves a stage by stable id first and positional index only for legacy events. */
function stageForPayload(payload: Record<string, unknown>, byIndex: Map<number, PipelineStageState>, byId: Map<string, PipelineStageState>): PipelineStageState | undefined {
	if (typeof payload.stageId === "string") return byId.get(payload.stageId);
	const stageIndex = readStageIndex(payload);
	return stageIndex === undefined ? undefined : byIndex.get(stageIndex);
}

/** Returns true when an event carries an attempt/fence that no longer owns the stage. */
function isStaleStageEvent(stage: PipelineStageState, payload: Record<string, unknown>): boolean {
	const attempt = readPositiveInt(payload.attempt);
	const fence = typeof payload.fencingToken === "string" ? payload.fencingToken : undefined;
	return (attempt !== undefined && stage.attempt !== undefined && attempt !== stage.attempt)
		|| (fence !== undefined && stage.fencingToken !== undefined && fence !== stage.fencingToken);
}

/** Maps a top-level status to a detailed stage status without exposing new values to v1 callers. */
function detailStatusFor(status: PipelineStatus): PipelineStageDetailStatus {
	if (status === "STOPPED") return "CANCELLED";
	if (status === "ACCEPTED") return "QUEUED";
	return status;
}

/** Reads a pipeline status from an untrusted event payload. */
function readPipelineStatus(value: unknown): PipelineStatus | undefined {
	return typeof value === "string" && isPipelineStatus(value) ? value : undefined;
}

/** Reads a detailed stage status from an untrusted event payload. */
function readDetailStatus(value: unknown): PipelineStageDetailStatus | undefined {
	return typeof value === "string" && ["QUEUED", "CLAIMED", "RUNNING", "DONE", "ERROR", "PARTIAL", "BLOCKED", "CANCELLED", "STALE", "WAITING_FOR_ANSWER", "WAITING_FOR_APPROVAL"].includes(value) ? value as PipelineStageDetailStatus : undefined;
}

/** Reads a positive integer from an untrusted event payload. */
function readPositiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Reads an event string without coercing other value types. */
function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads a targeted control action from a durable event. */
function readControlAction(value: unknown): PipelineControlEvent["action"] | undefined {
	return value === "answer" || value === "approve" || value === "reject" || value === "recover" || value === "stop" ? value : undefined;
}

/** Applies stage linkage, lease metadata, and exact session metadata from one event. */
function applyStageMetadata(stage: PipelineStageState, payload: Record<string, unknown>, session?: SessionIdentity): void {
	if (typeof payload.stageRole === "string") stage.role = payload.stageRole;
	if (typeof payload.communicationFile === "string") stage.communicationFile = payload.communicationFile;
	if (typeof payload.paneId === "string") stage.paneId = payload.paneId;
	if (typeof payload.agent === "string") stage.agent = payload.agent;
	if (typeof payload.deadlineAt === "string") stage.deadlineAt = payload.deadlineAt;
	if (typeof payload.expiresAt === "string") stage.expiresAt = payload.expiresAt;
	if (typeof payload.lastHeartbeatAt === "string") stage.lastHeartbeatAt = payload.lastHeartbeatAt;
	if (typeof payload.blockedReason === "string") stage.blockedReason = payload.blockedReason;
	if (typeof payload.resourceKeys === "string") stage.resourceKeys = [payload.resourceKeys];
	if (Array.isArray(payload.resourceKeys) && payload.resourceKeys.every((item) => typeof item === "string")) stage.resourceKeys = [...payload.resourceKeys as string[]];
	if (session) stage.agentSession = session;
	const payloadSession = payload.agentSession;
	if (!stage.agentSession && payloadSession && typeof payloadSession === "object" && !Array.isArray(payloadSession)) {
		const value = payloadSession as Record<string, unknown>;
		if (typeof value.kind === "string" && typeof value.source === "string" && typeof value.value === "string") {
			stage.agentSession = { kind: value.kind, source: value.source, value: value.value };
		}
	}
}

/** Reads and validates every JSONL inbox line. */
async function readInbox(file: string): Promise<PipelineInboxEntry[]> {
	const { readFile } = await import("node:fs/promises");
	const text = await readFile(file, "utf8");
	if (!text) return [];
	if (!text.endsWith("\n")) throw new Error(`Pipeline inbox has an incomplete final line: ${file}`);
	return text.trimEnd().split("\n").map((line, index) => {
		let value: unknown;
		try { value = JSON.parse(line); } catch { throw new Error(`Pipeline inbox line ${index + 1} is invalid JSON: ${file}`); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Pipeline inbox line ${index + 1} is not an object: ${file}`);
		const item = value as PipelineInboxEntry;
		if (item.schemaVersion !== 1 || item.enqueueSeq !== index + 1 || typeof item.pipelineId !== "string" || typeof item.communicationFile !== "string" || typeof item.messageId !== "string") {
			throw new Error(`Pipeline inbox line ${index + 1} has invalid identity fields: ${file}`);
		}
		if (resolve(item.communicationFile) !== resolve(dirname(file), `${item.pipelineId}.jsonl`)) {
			throw new Error(`Pipeline inbox line ${index + 1} has an unsafe communication path: ${file}`);
		}
		return item;
	});
}

/** Appends one compact inbox line; callers already hold the binding lock. */
async function appendInboxEntry(file: string, entry: PipelineInboxEntry): Promise<void> {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
}

/** Checks whether a replayed value is a recognized pipeline status. */
function isPipelineStatus(value: string): value is PipelineStatus {
	return ["QUEUED", "ACCEPTED", "RUNNING", "BLOCKED", "DONE", "PARTIAL", "ERROR", "STOPPED"].includes(value);
}

/** Returns the communication id for a pipeline event-log path. */
export function pipelineCommunicationId(file: string): string {
	return communicationIdFromPath(file);
}
