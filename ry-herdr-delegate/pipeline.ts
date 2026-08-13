import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { appendEvent, communicationIdFromPath, createEventLog, createEventLogEvent, readEventLog } from "./records.ts";
import { debug, debugError, hashDebugText } from "./debug.ts";
import type {
	AppendedEvent,
	CoordinatorBinding,
	EventActor,
	EventType,
	NewJsonlEvent,
	PanePolicy,
	PipelineRequest,
	PipelineStageInput,
	PipelineStatus,
	PipelineSubmission,
	SessionIdentity,
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
	/** Stage role used for profile resolution. */
	role: string;
	/** Latest stage status. */
	status: PipelineStatus;
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
}

/** Metadata written to the top-level event fields for stage checkpoints/results. */
export interface PipelineEventMetadata {
	/** Stage role for this event. */
	stageRole?: string;
	/** Stage occurrence for this role. */
	stageOccurrence?: number;
	/** Exact child session associated with the event. */
	agentSession?: SessionIdentity;
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
		const stages = parsedStages.length > 0 ? parsedStages : [defaultPipelineStage(context as Record<string, unknown>, panePolicy)];
		if (stages.length > maxStages) throw new Error(`pipeline has ${stages.length} stages; maximum is ${maxStages}`);
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
				stages: input.stages ?? [],
				panePolicy: input.panePolicy ?? "new-tab",
				context: input.context ?? {},
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
		await debug.log("pipeline.inbox.enqueue.start", { pipelineId: entry.pipelineId, communicationFile: entry.communicationFile, messageId: entry.messageId }, "debug");
		const queued = await this.coordinatorStore.withLock(async () => {
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
			return written;
		});
		await debug.log("pipeline.inbox.enqueued", { pipelineId: queued.pipelineId, enqueueSeq: queued.enqueueSeq, communicationFile: queued.communicationFile, messageId: queued.messageId }, "debug");
		return queued;
	}

	/** Reads the FIFO inbox under its shared binding lock. */
	async readInbox(): Promise<readonly PipelineInboxEntry[]> {
		return this.coordinatorStore.withLock(() => readInbox(this.inboxPath));
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
			schemaVersion: 1,
			eventId: messageId ? `${type}-${pipelineId}-${messageId}` : `${type}-${pipelineId}-${randomUUID()}`,
			...(messageId ? { messageId } : {}),
			timestamp: new Date().toISOString(),
			type,
			actor,
			transaction: pipelineId,
			stageRole: metadata.stageRole ?? "pipeline",
			stageOccurrence: metadata.stageOccurrence ?? 1,
			...(metadata.agentSession ? { agentSession: metadata.agentSession } : {}),
			payload,
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
		const stages = parsedStages.length > 0 ? parsedStages : [defaultPipelineStage(context as Record<string, unknown>, panePolicy)];
		if (stages.length > maxStages) throw new Error(`Pipeline ${pipelineId} has ${stages.length} stages; maximum is ${maxStages}`);
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
		};
	}

	/** Replays pipeline state and stage progress from the authoritative event log. */
	async readProgress(pipelineId: string, maxStages: number): Promise<PipelineProgress> {
		const request = await this.readRequest(pipelineId, maxStages);
		const state = await this.readState(pipelineId);
		const snapshot = await readEventLog(state.communicationFile);
		const stages = request.stages.map((stage, stageIndex): PipelineStageState => ({
			stageIndex,
			role: stage.role,
			status: "QUEUED",
			lastEventSeq: request.messageSeq,
			lastOutcomeSeq: 0,
		}));
		const stageMap = new Map(stages.map((stage) => [stage.stageIndex, stage]));
		let stopRequested = false;
		for (const located of snapshot.events) {
			const payload = located.event.payload;
			const stageIndex = readStageIndex(payload);
			if (located.event.type === "continuation" && typeof payload.answer === "string") {
				if (stageIndex !== undefined) {
					const stage = stageMap.get(stageIndex);
					if (stage) {
						stage.answer = payload.answer;
						stage.answerSeq = located.event.seq;
						stage.lastEventSeq = located.event.seq;
					}
				}
				continue;
			}
			if (located.event.type === "recovery" && stageIndex !== undefined) {
				const stage = stageMap.get(stageIndex);
				if (stage) {
					stage.recoverySeq = located.event.seq;
					stage.lastEventSeq = located.event.seq;
				}
				continue;
			}
			if (located.event.type === "status-changed") {
				const status = payload.status;
				if (status === "STOPPED") stopRequested = true;
				if (stageIndex !== undefined && typeof status === "string" && isPipelineStatus(status)) {
					const stage = stageMap.get(stageIndex);
					if (stage) {
						stage.status = status;
						stage.lastEventSeq = located.event.seq;
						applyStageMetadata(stage, payload, located.event.agentSession);
					}
				}
				continue;
			}
			if (located.event.type === "result" || located.event.type === "error") {
				if (stageIndex === undefined) continue;
				const stage = stageMap.get(stageIndex);
				if (!stage) continue;
				const status = typeof payload.status === "string" && isPipelineStatus(payload.status)
					? payload.status
					: located.event.type === "error" ? "ERROR" : "PARTIAL";
				stage.status = status;
				stage.lastEventSeq = located.event.seq;
				stage.lastOutcomeSeq = located.event.seq;
				applyStageMetadata(stage, payload, located.event.agentSession);
				if (typeof payload.summary === "string") stage.summary = payload.summary;
				if (typeof payload.error === "string") stage.summary = payload.error;
			}
		}
		return { state, request, stages, stopRequested };
	}

	/** Reads a durable pipeline event log and derives its current status. */
	async readState(pipelineId: string): Promise<PipelineState> {
		const communicationFile = this.pipelinePath(pipelineId);
		const snapshot = await readEventLog(communicationFile);
		let status: PipelineStatus = "QUEUED";
		let currentStage: string | undefined;
		let summary: string | undefined;
		let acceptedSeq: number | undefined;
		for (const located of snapshot.events) {
			const payload = located.event.payload;
			if (located.event.type === "accepted") {
				status = "ACCEPTED";
				acceptedSeq = located.event.seq;
			}
			if (located.event.type === "status-changed") {
				const nextStatus = payload.status;
				if (!Object.prototype.hasOwnProperty.call(payload, "stageIndex") && typeof nextStatus === "string" && isPipelineStatus(nextStatus)) status = nextStatus;
				if (typeof payload.currentStage === "string") currentStage = payload.currentStage;
			}
			if (located.event.type === "result" || located.event.type === "error") {
				if (!Object.prototype.hasOwnProperty.call(payload, "stageIndex") && typeof payload.status === "string" && isPipelineStatus(payload.status)) status = payload.status;
				if (typeof payload.summary === "string") summary = payload.summary;
				if (typeof payload.error === "string") summary = payload.error;
			}
		}
		return { pipelineId, communicationFile, status, lastSeq: snapshot.events.at(-1)?.event.seq ?? 0, currentStage, summary, acceptedSeq };
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

/** Validates a pipeline pane policy from an event payload. */
function parsePanePolicy(value: unknown, path: string): PanePolicy {
	if (value !== "close" && value !== "keep" && value !== "new-tab") throw new Error(`${path} must be close, keep, or new-tab`);
	return value;
}

/** Validates one pipeline stage without coercing unknown values. */
function parsePipelineStage(value: unknown, path: string): PipelineStageInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	const input = value as Record<string, unknown>;
	const allowed = new Set(["role", "task", "agent", "effort", "extraArgs", "cwd", "timeoutMs", "panePolicy"]);
	for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`${path}.${key} is an unknown field`);
	if (typeof input.role !== "string" || !input.role.trim()) throw new Error(`${path}.role must be a non-empty string`);
	if (!isSupportedRole(input.role)) throw new Error(`${path}.role is not configured or supported`);
	if (input.task !== undefined && (typeof input.task !== "string" || !input.task.trim())) throw new Error(`${path}.task must be a non-empty string`);
	if (input.agent !== undefined && input.agent !== "codex" && input.agent !== "claude" && input.agent !== "pi") throw new Error(`${path}.agent is unsupported`);
	if (input.effort !== undefined && typeof input.effort !== "string") throw new Error(`${path}.effort must be a string`);
	if (input.extraArgs !== undefined && (!Array.isArray(input.extraArgs) || input.extraArgs.some((item) => typeof item !== "string"))) throw new Error(`${path}.extraArgs must be an array of strings`);
	if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.trim())) throw new Error(`${path}.cwd must be a non-empty string`);
	if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)) throw new Error(`${path}.timeoutMs must be a positive safe integer`);
	if (input.panePolicy !== undefined) parsePanePolicy(input.panePolicy, `${path}.panePolicy`);
	return {
		role: input.role,
		...(input.task !== undefined ? { task: input.task } : {}),
		...(input.agent !== undefined ? { agent: input.agent } : {}),
		...(input.effort !== undefined ? { effort: input.effort } : {}),
		...(input.extraArgs !== undefined ? { extraArgs: input.extraArgs as string[] } : {}),
		...(input.cwd !== undefined ? { cwd: input.cwd as string } : {}),
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs as number } : {}),
		...(input.panePolicy !== undefined ? { panePolicy: input.panePolicy as PanePolicy } : {}),
	};
}

/** Reads a stage index from a structured pipeline event payload. */
function readStageIndex(payload: Record<string, unknown>): number | undefined {
	return Number.isSafeInteger(payload.stageIndex) && (payload.stageIndex as number) >= 0 ? payload.stageIndex as number : undefined;
}

/** Applies stage linkage and exact session metadata from one pipeline event. */
function applyStageMetadata(stage: PipelineStageState, payload: Record<string, unknown>, session?: SessionIdentity): void {
	if (typeof payload.stageRole === "string") stage.role = payload.stageRole;
	if (typeof payload.communicationFile === "string") stage.communicationFile = payload.communicationFile;
	if (typeof payload.paneId === "string") stage.paneId = payload.paneId;
	if (typeof payload.agent === "string") stage.agent = payload.agent;
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
