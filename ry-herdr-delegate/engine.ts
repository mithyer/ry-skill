import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { AgentTurnMonitor, type AgentTurnBaseline, type AgentTurnObservationInput, isDefinitivelyClosedAgentError } from "./agent-monitor.ts";
import { buildFinalAgentArgs } from "./args.ts";
import { resolveAgentProfile, type ConfigCapabilities } from "./config.ts";
import { debug, debugError, hashDebugText } from "./debug.ts";
import { planPaneDisposition } from "./pane-policy.ts";
import { appendEvent, communicationIdFromPath, createEventLog, createEventLogEvent, readEventLog } from "./records.ts";
import { isSemanticDone, parseCompletionContract } from "./result.ts";
import type {
	CompletionContract,
	DelegateConfig,
	DelegateContext,
	DelegateRequest,
	DelegateResult,
	HerdrAgentSnapshot,
	HerdrGateway,
	HerdrPane,
	JsonlEvent,
	NewJsonlEvent,
	PanePolicy,
	SemanticStatus,
	SessionIdentity,
} from "./types.ts";

/** Dependencies injected into the leaf engine for tests and alternative runtimes. */
export interface DelegateEngineDependencies {
	/** Gateway responsible for all Herdr side effects. */
	gateway: HerdrGateway;
	/** Parsed delegate configuration. */
	config: DelegateConfig;
	/** Project-root record directory override. */
	communicationDirectory?: string;
	/** Capability flags controlling environment forwarding. */
	capabilities?: ConfigCapabilities;
	/** Clock used for deterministic event timestamps in tests. */
	now?: () => Date;
	/** Stable id generator used for transaction and communication names. */
	id?: () => string;
	/** Optional delay seam used for bounded terminal-output refresh retries. */
	sleep?: (milliseconds: number) => Promise<void>;
}

/** Exact direct-leaf context required to reconcile a late Pi completion without creating a new child. */
export interface DelegateReconciliationContext {
	/** Herdr workspace that must still own the original child pane. */
	workspaceId: string;
	/** Optional workspace layout lock used only when applying a validated DONE disposition. */
	layoutLock?: <T>(callback: () => Promise<T>) => Promise<T>;
}

/** Runtime-only context attached to one leaf engine execution. */
interface LeafRuntime {
	communicationFile: string;
	communicationId: string;
	transaction: string;
	stageRole: string;
	stageId?: string;
	stageOccurrence: number;
	owner: "parent" | "coordinator";
	panePolicy: PanePolicy;
	cwd: string;
	workspaceId: string;
	agent: string;
	paneId: string;
	/** Absolute deadline shared by every operation in this stage attempt. */
	deadlineAt?: number;
	/** Durable attempt/fencing identity. */
	attempt?: number;
	fencingToken?: string;
	/** Parent/coordinator execution fence used by monitor result keys. */
	executionFence: string;
	/** Output fingerprint captured before the formal relay. */
	baseline?: AgentTurnBaseline;
	/** Timestamp when the logical relay submission began. */
	submittedAt?: string;
	/** Continuations require an explicit current relay marker in terminal output. */
	requireRelayAnchor?: boolean;
	/** Resource metadata copied into each stage checkpoint. */
	resourceKeys?: readonly string[];
	access?: string;
	/** Workspace layout lock retained until each pane mutation completes. */
	layoutLock?: <T>(callback: () => Promise<T>) => Promise<T>;
	session?: SessionIdentity;
}

/** One terminal pane capture together with its parsed or explicit error completion contract. */
interface CapturedCompletion {
	/** Parsed child completion or a contract-shaped parser failure after bounded refresh retries. */
	completion: CompletionContract;
	/** One-based terminal-output capture attempt count. */
	attempts: number;
	/** Durable source that supplied the parsed completion contract. */
	source: "pi-session" | "terminal";
}

/** Minimal Pi session message retained while locating one exact relay response. */
interface PiSessionMessage {
	/** Pi conversation role represented by the serialized message. */
	role: "assistant" | "user";
	/** Joined text segments from the message content. */
	text: string;
}

/** Creates a single-line structured event payload from arbitrary task context. */
function event(
	type: NewJsonlEvent["type"],
	actor: NewJsonlEvent["actor"],
	runtime: LeafRuntime,
	payload: Record<string, unknown>,
	messageId?: string,
	agentSession?: SessionIdentity,
): NewJsonlEvent {
	return {
		schemaVersion: runtime.attempt !== undefined || runtime.fencingToken ? 2 : 1,
		eventId: `${type}-${randomUUID()}`,
		timestamp: new Date().toISOString(),
		type,
		actor,
		transaction: runtime.transaction,
		stageRole: runtime.stageRole,
		stageOccurrence: runtime.stageOccurrence,
		...(messageId ? { messageId } : {}),
		...(agentSession ? { agentSession } : {}),
		payload: {
			...payload,
			...(runtime.attempt !== undefined ? { attempt: runtime.attempt } : {}),
			...(runtime.fencingToken ? { fencingToken: runtime.fencingToken } : {}),
			...(runtime.executionFence ? { executionFence: runtime.executionFence } : {}),
			...(runtime.stageId ? { stageId: runtime.stageId } : {}),
			...(runtime.submittedAt ? { submittedAt: runtime.submittedAt } : {}),
			...(runtime.resourceKeys ? { resourceKeys: runtime.resourceKeys } : {}),
			...(runtime.access ? { access: runtime.access } : {}),
			...(runtime.deadlineAt !== undefined ? { deadlineAt: new Date(runtime.deadlineAt).toISOString() } : {}),
		},
	};
}

/** Builds the fixed relay envelope with no task-specific text outside the event log. */
export function buildRelayEnvelope(file: string, lineStart: number, lineEnd: number, lineCount: number, messageId: string, messageType: "task" | "continuation" = "task"): string {
	return [
		`COMMUNICATION FILE: ${file}`,
		`MESSAGE SEQ: ${lineStart}`,
		`MESSAGE LINES: ${lineStart}-${lineEnd}`,
		`MESSAGE LINE COUNT: ${lineCount}`,
		`MESSAGE ID: ${messageId}`,
		`MESSAGE TYPE: ${messageType}`,
		"",
		"Read and parse this JSONL event before acting.",
		"Return exactly these three headings, each on its own line:",
		"STATUS: DONE|BLOCKED|PARTIAL|ERROR",
		"SUMMARY: <one-line result>",
		"VALIDATION: <commands or checks performed>",
		"Use STATUS: DONE only when the task is complete and validated.",
		"Do not delegate recursively.",
	].join("\n");
}

/** Generates a durable communication filename from the task role and a short id. */
function communicationPath(directory: string, role: string, id: string): string {
	const safeRole = role.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "delegate";
	return join(directory, `${safeRole}-${id}.jsonl`);
}

/** Compares all fields of two exact agent-session identities. */
function sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
	return left.kind === right.kind && left.source === right.source && left.value === right.value;
}

/** Narrows a persisted pane policy before a reconciliation can move or close a child pane. */
function isPanePolicy(value: unknown): value is PanePolicy {
	return value === "close" || value === "keep" || value === "new-tab";
}

/** Checks whether an exact Herdr-reported session can be read as a local Pi JSONL file. */
function isReadablePiSession(session: SessionIdentity | undefined): session is SessionIdentity {
	return Boolean(
		session
		&& session.kind === "path"
		&& session.source === "herdr:pi"
		&& isAbsolute(session.value)
		&& session.value.endsWith(".jsonl"),
	);
}

/** Narrows an unknown JSON value into a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Extracts text-only Pi content so tool calls and reasoning never become completion evidence. */
function piMessageText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const text: string[] = [];
	for (const item of content) {
		const segment = asRecord(item);
		if (segment?.type === "text" && typeof segment.text === "string") text.push(segment.text);
	}
	return text.join("\n");
}

/** Decodes complete user and assistant text messages from an append-only Pi session file. */
function parsePiSessionMessages(text: string): readonly PiSessionMessage[] {
	const messages: PiSessionMessage[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = asRecord(JSON.parse(line));
			const message = entry?.type === "message" ? asRecord(entry.message) : undefined;
			const role = message?.role;
			if (!message || (role !== "assistant" && role !== "user")) continue;
			const messageText = piMessageText(message.content);
			if (messageText) messages.push({ role, text: messageText });
		} catch {
			// A session may be mid-append; complete earlier entries remain safe to inspect.
		}
	}
	return messages;
}

/** Matches the parent-generated relay markers so an older Pi turn cannot supply this completion. */
function isMatchingPiRelay(text: string, communicationFile: string, messageId: string): boolean {
	const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
	return lines.has(`COMMUNICATION FILE: ${communicationFile}`) && lines.has(`MESSAGE ID: ${messageId}`);
}

/** Finds a strict completion response associated with one exact relay in a Pi session. */
function parsePiRelayCompletion(text: string, communicationFile: string, messageId: string): CompletionContract | undefined {
	const messages = parsePiSessionMessages(text);
	let relayIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user" && isMatchingPiRelay(messages[index].text, communicationFile, messageId)) {
			relayIndex = index;
			break;
		}
	}
	if (relayIndex < 0) return undefined;
	let assistantText: string | undefined;
	for (let index = relayIndex + 1; index < messages.length; index += 1) {
		if (messages[index].role === "user") break;
		if (messages[index].role === "assistant") assistantText = messages[index].text;
	}
	if (!assistantText) return undefined;
	try {
		return parseCompletionContract(assistantText);
	} catch {
		return undefined;
	}
}

/** Converts any gateway or parser failure into a semantic result without closing the pane. */
function failureResult(runtime: LeafRuntime, status: SemanticStatus, error: unknown): DelegateResult {
	return {
		status,
		communicationId: runtime.communicationId,
		communicationFile: runtime.communicationFile,
		paneId: runtime.paneId,
		agent: runtime.agent,
		agentSession: runtime.session,
		error: error instanceof Error ? error.message : String(error),
	};
}

/** Marks a pre-relay baseline that cannot prove exact identity or readable output. */
class BaselineCaptureError extends Error {
	/** Creates a fail-closed baseline error. */
	constructor(message: string) {
		super(message);
		this.name = "BaselineCaptureError";
	}
}

/** Reads the gateway's explicit relay-delivery classification without guessing from messages. */
function deliveryStateFor(error: unknown): "NOT_SENT" | "UNKNOWN" {
	if (!error || typeof error !== "object") return "UNKNOWN";
	const state = (error as { deliveryState?: unknown }).deliveryState;
	return state === "NOT_SENT" ? "NOT_SENT" : "UNKNOWN";
}

/** Detects a Herdr command timeout without confusing it with a parent cancellation or agent failure. */
function isHerdrCommandTimeout(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	return (error as { timedOut?: unknown }).timedOut === true;
}

/** Owns one leaf delegation transaction from event-log handoff through pane disposition. */
export class DelegateEngine {
	/** Injectable engine dependencies. */
	private readonly dependencies: DelegateEngineDependencies;

	/**
	 * Creates a leaf engine.
	 *
	 * @param dependencies Gateway, configuration, record directory, capabilities, and test seams.
	 */
	constructor(dependencies: DelegateEngineDependencies) {
		this.dependencies = dependencies;
	}

	/**
	 * Executes one structured leaf delegation request.
	 *
	 * @param request Structured delegate request.
	 * @param context Current project and Herdr pane context.
	 * @param signal Optional cancellation signal.
	 * @returns Durable semantic result and exact recovery metadata.
	 * TEST:engine.test.ts[DelegateEngine completes a leaf only after exact checkpoint and DONE contract]
	 */
	async run(request: DelegateRequest, context: DelegateContext, signal?: AbortSignal): Promise<DelegateResult> {
		if (request.action !== "delegate") throw new Error(`Unsupported leaf action: ${request.action}`);
		if (this.dependencies.gateway.probe) await this.dependencies.gateway.probe(signal);
		if (!request.task.trim()) throw new Error("delegate task must be non-empty");
		const role = request.role;
		const overrides = request.overrides ?? {};
		const profile = resolveAgentProfile(this.dependencies.config, role, overrides, this.dependencies.capabilities);
		const communicationDirectory = this.dependencies.communicationDirectory ?? join(context.cwd, ".pi", "agent", "ry-herdr-delegate", "communications");
		await mkdir(communicationDirectory, { recursive: true });
		const id = this.dependencies.id ?? (() => randomUUID().slice(0, 12));
		const transaction = request.transaction ?? `tx-${id()}`;
		const stageOccurrence = request.stageOccurrence ?? 1;
		const owner = context.executionOwner ?? "parent";
		const requestedDeadline = request.deadlineAt ? Date.parse(request.deadlineAt) : Number.NaN;
		const deadlineAt = Number.isFinite(requestedDeadline) ? requestedDeadline : Date.now() + profile.timeoutMs + 30_000;
		if (deadlineAt <= Date.now()) throw new Error("delegate stage deadline has expired");
		if (request.previousSession && !request.previousCommunication) throw new Error("exact stage continuation requires its previous communication log");
		const communicationFile = request.communicationFile ?? request.previousCommunication ?? communicationPath(communicationDirectory, role, id());
		const runtime: LeafRuntime = {
			communicationFile,
			communicationId: communicationIdFromPath(communicationFile),
			transaction,
			stageRole: role,
			stageId: request.stageId,
			stageOccurrence,
			owner,
			panePolicy: profile.panePolicy,
			cwd: overrides.cwd ?? context.cwd,
			workspaceId: context.workspaceId,
			agent: request.previousAgent ?? `${role}-${id()}`,
			paneId: request.previousPaneId ?? "pending",
			deadlineAt,
			attempt: request.attempt ?? 1,
			fencingToken: request.fencingToken,
			executionFence: request.executionFence ?? request.fencingToken ?? `${owner}:${transaction}`,
			requireRelayAnchor: Boolean(request.previousCommunication),
			resourceKeys: context.resourceKeys ?? request.resourceKeys,
			access: context.access ?? request.access,
			layoutLock: context.layoutLock,
		};
		await debug.log("leaf.run.start", {
			transaction,
			stageRole: role,
			stageOccurrence,
			owner,
			workspaceId: context.workspaceId,
			sourcePaneId: context.sourcePaneId,
			cwd: runtime.cwd,
			communicationId: runtime.communicationId,
			communicationFile,
			agentKind: profile.kind,
			timeoutMs: profile.timeoutMs,
			panePolicy: runtime.panePolicy,
			hasPreviousCommunication: Boolean(request.previousCommunication),
			hasPreviousSession: Boolean(request.previousSession),
			task: { length: request.task.length, sha256: hashDebugText(request.task) },
		}, "info");
		const deadlineController = new AbortController();
		const abortOperation = (): void => {
			if (!deadlineController.signal.aborted) deadlineController.abort(signal?.reason ?? new Error("delegate stage deadline expired"));
		};
		if (signal?.aborted) abortOperation();
		else signal?.addEventListener("abort", abortOperation, { once: true });
		const deadlineTimer = setTimeout(abortOperation, Math.max(1, deadlineAt - Date.now()));
		deadlineTimer.unref?.();
		const operationSignal = deadlineController.signal;
		try {
			const existing = Boolean(request.previousCommunication);
			if (existing) {
				const snapshot = await readEventLog(communicationFile);
				const created = snapshot.events[0]?.event;
				if (!created || created.type !== "event-log-created" || created.transaction !== transaction || created.stageRole !== role || created.stageOccurrence !== stageOccurrence) {
					throw new Error("previous communication log identity does not match this pipeline stage");
				}
				if (!request.previousSession) throw new Error("previous communication log requires an exact previous session");
				const lastSession = [...snapshot.events].reverse().find(({ event: item }) => item.agentSession)?.event.agentSession;
				if (!lastSession || !sameSession(lastSession, request.previousSession)) throw new Error("previous communication log session does not match the requested exact session");
				const lastResult = [...snapshot.events].reverse().find(({ event: item }) => item.type === "result" || item.type === "error");
				if (lastResult?.event.payload.status === "DONE") throw new Error("cannot continue a stage whose communication log is already DONE");
			}
			if (!existing) await createEventLog(communicationFile);
			if (!existing) await appendEvent(communicationFile, createEventLogEvent(transaction, role, stageOccurrence, owner));
			await debug.log("leaf.record.ready", { communicationId: runtime.communicationId, communicationFile, existing }, "debug");
			const messageId = existing ? `continuation-${runtime.communicationId}-${id()}` : `msg-${id()}`;
			const messageType = existing ? "continuation" : "task";
			const handoff = await appendEvent(communicationFile, event(messageType, owner, runtime, {
				task: request.task,
				role,
				agent: profile.kind,
				agentArgs: buildFinalAgentArgs(profile, request.previousSession),
				autonomyEnabled: profile.autonomyEnabled,
				panePolicy: runtime.panePolicy,
				transaction,
				stageOccurrence,
				owner,
				communicationFile,
				previousCommunication: request.previousCommunication,
				previousSession: request.previousSession,
				continuation: request.continuation,
				cwd: overrides.cwd ?? context.cwd,
			}, messageId),
		);
			const relay = buildRelayEnvelope(communicationFile, handoff.lineStart, handoff.lineEnd, handoff.lineCount, messageId, messageType);
			await debug.log("leaf.handoff.appended", {
				communicationId: runtime.communicationId,
				messageId,
				messageType,
				lineStart: handoff.lineStart,
				lineEnd: handoff.lineEnd,
				lineCount: handoff.lineCount,
				idempotent: handoff.idempotent,
			}, "trace");
			const existingAgent = await this.reuseExistingPane(runtime, request, owner, operationSignal);
			if (existingAgent) {
				await debug.log("leaf.session.reused", {
					communicationId: runtime.communicationId,
					agent: existingAgent.agent,
					paneId: existingAgent.paneId,
					status: existingAgent.status,
					agentSession: existingAgent.agentSession,
				}, "debug");
				await this.captureBaseline(runtime, owner, operationSignal);
				await this.submitRelay(runtime, relay, owner, messageId, operationSignal);
				await debug.log("leaf.relay.sent", { communicationId: runtime.communicationId, agent: existingAgent.agent, paneId: existingAgent.paneId, messageType, waitForTurn: false }, "debug");
				return await this.waitAndResolve(runtime, profile.timeoutMs, owner, messageId, operationSignal);
			}
			await debug.log("leaf.pane.split.start", { communicationId: runtime.communicationId, sourcePaneId: context.sourcePaneId, cwd: runtime.cwd }, "debug");
			const finalArgs = buildFinalAgentArgs(profile, request.previousSession);
			const splitPane = (): Promise<HerdrPane> => this.dependencies.gateway.splitPane({
				sourcePaneId: context.sourcePaneId,
				direction: "right",
				cwd: runtime.cwd,
				env: profile.env,
				focus: false,
				signal: operationSignal,
			});
			// Pane creation is serialized, but relay/wait remains outside the layout lock.
			const pane = context.layoutLock ? await context.layoutLock(splitPane) : await splitPane();
			runtime.paneId = pane.paneId;
			await debug.log("leaf.pane.split.result", { communicationId: runtime.communicationId, paneId: pane.paneId, workspaceId: pane.workspaceId, tabId: pane.tabId }, "debug");
			const startAgent = (): Promise<HerdrAgentSnapshot> => this.dependencies.gateway.startAgent({
				name: runtime.agent,
				kind: profile.kind,
				paneId: pane.paneId,
				agentArgs: finalArgs,
				signal: operationSignal,
			});
			const started = context.layoutLock ? await context.layoutLock(startAgent) : await startAgent();
			runtime.agent = started.agent;
			runtime.paneId = started.paneId;
			await debug.log("leaf.agent.started", {
				communicationId: runtime.communicationId,
				agent: started.agent,
				paneId: started.paneId,
				workspaceId: started.workspaceId,
				status: started.status,
				agentSession: started.agentSession,
			}, "debug");
			const observedSession = started.agentSession;
			runtime.session = request.previousSession ?? observedSession;
			if (!observedSession) {
				await debug.log("leaf.agent.session-missing", { communicationId: runtime.communicationId, agent: started.agent, paneId: started.paneId, status: started.status }, "warn");
				await appendEvent(communicationFile, event("checkpoint", owner, runtime, {
					transportStatus: started.status,
					paneId: started.paneId,
					agent: started.agent,
					cwd: started.cwd,
					operation: "start",
					accepted: true,
					observedTransportStatus: started.status,
					error: "Herdr did not return exact agent_session metadata",
				}, undefined, request.previousSession));
				return failureResult(runtime, "BLOCKED", "Herdr did not return exact agent_session metadata");
			}
			if (request.previousSession && !sameSession(observedSession, request.previousSession)) {
				await debug.log("leaf.agent.session-mismatch", {
					communicationId: runtime.communicationId,
					agent: started.agent,
					paneId: started.paneId,
					expectedAgentSession: request.previousSession,
					observedAgentSession: observedSession,
				}, "warn");
				await appendEvent(communicationFile, event("checkpoint", owner, runtime, {
					transportStatus: started.status,
					paneId: started.paneId,
					agent: started.agent,
					cwd: started.cwd,
					expectedAgentSession: request.previousSession,
					observedAgentSession: observedSession,
					error: "Exact-session resume returned a different agent_session",
				}, undefined, request.previousSession));
				return failureResult(runtime, "BLOCKED", "Exact-session resume returned a different agent_session");
			}
			runtime.session = observedSession;
			await appendEvent(communicationFile, event("checkpoint", owner, runtime, {
				transportStatus: started.status,
				paneId: started.paneId,
				agent: started.agent,
				cwd: started.cwd,
				operation: "start",
				accepted: true,
				observedTransportStatus: started.status,
			}, undefined, observedSession));
			await this.captureBaseline(runtime, owner, operationSignal);
			await this.submitRelay(runtime, relay, owner, messageId, operationSignal);
			await debug.log("leaf.relay.sent", { communicationId: runtime.communicationId, agent: started.agent, paneId: started.paneId, messageType, waitForTurn: false }, "debug");
			return await this.waitAndResolve(runtime, profile.timeoutMs, owner, messageId, operationSignal);
		} catch (error) {
			await debug.log("leaf.run.failed", { communicationId: runtime.communicationId, transaction: runtime.transaction, stageRole: runtime.stageRole, error: debugError(error) }, "error");
			const commandTimedOut = isHerdrCommandTimeout(error);
			if (commandTimedOut) {
				// Herdr's local command timer can abort prompt --wait while the external child keeps working.
				await appendEvent(communicationFile, event("checkpoint", owner, runtime, {
					transportStatus: "unknown",
					operation: "prompt",
					accepted: "unknown",
					error: error instanceof Error ? error.message : String(error),
				}, undefined, runtime.session)).catch(() => undefined);
			}
			await appendEvent(communicationFile, event("error", owner, runtime, { error: error instanceof Error ? error.message : String(error) })).catch(() => undefined);
			const blocked = error instanceof BaselineCaptureError;
			const deadlineExpired = runtime.deadlineAt !== undefined && Date.now() >= runtime.deadlineAt;
			const unfinishedOperation = operationSignal.aborted || deadlineExpired || commandTimedOut;
			const status: SemanticStatus = blocked ? "BLOCKED" : unfinishedOperation ? "PARTIAL" : "ERROR";
			return failureResult(runtime, status, unfinishedOperation && !blocked ? "delegate stage operation was aborted" : error);
		} finally {
			clearTimeout(deadlineTimer);
			signal?.removeEventListener("abort", abortOperation);
		}
	}

	/**
	 * Reconciles a late completion from the original exact Pi child after a direct leaf returned PARTIAL.
	 *
	 * This is deliberately read-only until the stored relay, current pane, workspace, and full session triple
	 * all agree. It never sends another relay, starts an agent, or substitutes a new session.
	 *
	 * @param previous Original PARTIAL leaf result retained by the direct UI monitor.
	 * @param context Exact workspace and layout context still owned by the parent Pi session.
	 * @param signal Optional cancellation signal for non-mutating Herdr inspection and disposition.
	 * @returns A newly durable terminal result, or undefined when exact late-completion evidence is unavailable.
	 * TEST:engine.test.ts[DelegateEngine reconciles a late exact Pi completion without resending]
	 */
	async reconcilePartial(
		previous: DelegateResult,
		context: DelegateReconciliationContext,
		signal?: AbortSignal,
	): Promise<DelegateResult | undefined> {
		if (previous.status !== "PARTIAL" || !previous.agent || !previous.paneId || !previous.agentSession) return undefined;
		const snapshot = await readEventLog(previous.communicationFile);
		const created = snapshot.events[0]?.event;
		const handoff = [...snapshot.events].reverse().find(({ event: item }) => (item.type === "task" || item.type === "continuation") && typeof item.messageId === "string");
		const persistedSession = [...snapshot.events].reverse().find(({ event: item }) => item.agentSession)?.event.agentSession;
		if (!created || created.type !== "event-log-created" || !handoff?.event.messageId || !persistedSession
			|| created.transaction !== handoff.event.transaction
			|| created.stageRole !== handoff.event.stageRole
			|| created.stageOccurrence !== handoff.event.stageOccurrence
			|| !sameSession(persistedSession, previous.agentSession)) {
			await debug.log("leaf.reconcile.identity-unavailable", {
				communicationId: previous.communicationId,
				agent: previous.agent,
				paneId: previous.paneId,
			}, "warn");
			return undefined;
		}
		const persistedCwd = handoff.event.payload.cwd;
		const persistedPanePolicy = handoff.event.payload.panePolicy;
		if (typeof persistedCwd !== "string" || !isPanePolicy(persistedPanePolicy)) {
			await debug.log("leaf.reconcile.record-invalid", {
				communicationId: previous.communicationId,
				agent: previous.agent,
				paneId: previous.paneId,
			}, "warn");
			return undefined;
		}
		let observed: HerdrAgentSnapshot;
		try {
			observed = await this.dependencies.gateway.getAgent(previous.agent, signal);
		} catch (error) {
			await debug.log("leaf.reconcile.lookup-failed", {
				communicationId: previous.communicationId,
				agent: previous.agent,
				error: debugError(error),
			}, "trace");
			return undefined;
		}
		if (observed.agent !== previous.agent
			|| observed.paneId !== previous.paneId
			|| observed.workspaceId !== context.workspaceId
			|| !observed.agentSession
			|| !sameSession(observed.agentSession, previous.agentSession)
			|| !["idle", "done", "blocked"].includes(observed.status)) {
			await debug.log("leaf.reconcile.continuity-unavailable", {
				communicationId: previous.communicationId,
				agent: previous.agent,
				paneId: previous.paneId,
				observedPaneId: observed.paneId,
				observedWorkspaceId: observed.workspaceId,
				transportStatus: observed.status,
				observedAgentSession: observed.agentSession,
			}, "trace");
			return undefined;
		}
		const runtime: LeafRuntime = {
			communicationFile: previous.communicationFile,
			communicationId: previous.communicationId,
			transaction: handoff.event.transaction,
			stageRole: handoff.event.stageRole,
			stageId: typeof handoff.event.payload.stageId === "string" ? handoff.event.payload.stageId : undefined,
			stageOccurrence: handoff.event.stageOccurrence,
			owner: "parent",
			panePolicy: persistedPanePolicy,
			cwd: persistedCwd,
			workspaceId: context.workspaceId,
			agent: observed.agent,
			paneId: observed.paneId,
			attempt: typeof handoff.event.payload.attempt === "number" ? handoff.event.payload.attempt : 1,
			fencingToken: typeof handoff.event.payload.fencingToken === "string" ? handoff.event.payload.fencingToken : undefined,
			executionFence: typeof handoff.event.payload.executionFence === "string" ? handoff.event.payload.executionFence : handoff.event.transaction,
			layoutLock: context.layoutLock,
			session: observed.agentSession,
		};
		const baselineEvent = [...snapshot.events].reverse().find(({ event: item }) => item.type === "pre-relay-checkpoint" && typeof item.payload.baselineFingerprint === "string");
		let baseline: AgentTurnBaseline;
		if (baselineEvent) {
			baseline = {
				fingerprint: baselineEvent.event.payload.baselineFingerprint as string,
				length: typeof baselineEvent.event.payload.baselineLength === "number" ? baselineEvent.event.payload.baselineLength : 0,
				capturedAt: typeof baselineEvent.event.payload.baselineCapturedAt === "string" ? baselineEvent.event.payload.baselineCapturedAt : new Date().toISOString(),
				source: "terminal",
			};
		} else {
			try {
				const output = (await this.dependencies.gateway.readAgent(observed.agent, signal)).text;
				baseline = {
					fingerprint: hashDebugText(output) ?? "",
					length: output.length,
					capturedAt: new Date().toISOString(),
					source: "terminal",
				};
			} catch (error) {
				await debug.log("leaf.reconcile.baseline-unavailable", { communicationId: previous.communicationId, error: debugError(error) }, "trace");
				return undefined;
			}
		}
		await appendEvent(runtime.communicationFile, event("checkpoint", "parent", runtime, {
			transportStatus: observed.status,
			operation: "reconcile",
			accepted: true,
			observedTransportStatus: observed.status,
			paneId: observed.paneId,
			agent: observed.agent,
			cwd: observed.cwd,
			reusedExactSession: true,
		}, undefined, observed.agentSession));
		const monitorInput: AgentTurnObservationInput = {
			target: observed.agent,
			paneId: observed.paneId,
			workspaceId: context.workspaceId,
			transactionId: runtime.transaction,
			stageId: runtime.stageId ?? runtime.stageRole,
			stageOccurrence: runtime.stageOccurrence,
			attempt: runtime.attempt ?? 1,
			fencingToken: runtime.fencingToken,
			executionFence: runtime.executionFence,
			expectedSession: runtime.session!,
			communicationFile: runtime.communicationFile,
			relayMessageId: handoff.event.messageId,
			baseline,
			deadlineAt: new Date(Date.now() + 5_000).toISOString(),
			submittedAt: handoff.event.timestamp,
			owner: "parent",
			requireRelayAnchor: true,
			signal,
		};
		const monitor = new AgentTurnMonitor({
			gateway: this.dependencies.gateway,
			sleep: this.dependencies.sleep,
			pollIntervalMs: 250,
			maxAttempts: 20,
			captureFallback: async (input) => {
				const captured = await this.capturePiSessionCompletion(runtime, input.relayMessageId);
				return captured ? { completion: captured.completion, source: "pi-session" as const, attempts: captured.attempts } : undefined;
			},
			onObservation: async (observation) => {
				await appendEvent(runtime.communicationFile, event("observation", "child-output-capture", runtime, {
					operation: "reconcile-observe",
					transportStatus: observation.transportStatus,
					readAttempt: observation.readAttempt,
					outputFingerprint: observation.outputFingerprint,
					outputLength: observation.outputLength,
					postSubmit: observation.postSubmit,
					relayAnchor: observation.relayAnchor,
				}, undefined, observation.agentSession));
			},
		});
		const observedResult = await monitor.observe(monitorInput);
		if (!observedResult.completion) return undefined;
		runtime.paneId = observedResult.paneId;
		runtime.agent = observedResult.agent;
		runtime.session = observedResult.agentSession;
		const previousResult = [...snapshot.events].reverse().find(({ event: item }) => item.type === "result" && item.payload.status === "PARTIAL");
		const recoverySeq = snapshot.events.filter(({ event: item }) => item.type === "reconciliation-result").length + 1;
		const completion = observedResult.completion;
		await appendEvent(runtime.communicationFile, event("reconciliation-result", "child-output-capture", runtime, {
			status: observedResult.status,
			operation: "reconcile",
			accepted: true,
			observedTransportStatus: observedResult.transportStatus,
			captureAttempt: observedResult.observations,
			captureSource: observedResult.captureSource,
			reconciliation: true,
			relayMessageId: handoff.event.messageId,
			resultKey: observedResult.resultKey,
			recoverySeq,
			supersedesEventId: previousResult?.event.eventId,
			summary: completion.summary,
			changedFiles: completion.changedFiles,
			validation: completion.validation,
			risks: completion.risks,
		}, undefined, runtime.session));
		await debug.log("leaf.reconcile.completion", {
			communicationId: runtime.communicationId,
			agent: runtime.agent,
			paneId: runtime.paneId,
			transportStatus: observedResult.transportStatus,
			semanticStatus: observedResult.status,
			resultKey: observedResult.resultKey,
		}, "info");
		if (observedResult.status === "BLOCKED") {
			return {
				status: "BLOCKED",
				communicationId: runtime.communicationId,
				communicationFile: runtime.communicationFile,
				paneId: runtime.paneId,
				agent: runtime.agent,
				agentSession: runtime.session,
				completion,
				error: completion.summary ?? "Child transport is blocked",
			};
		}
		if (observedResult.status === "DONE" && isSemanticDone(completion)) return this.completeDone(runtime, completion, "parent", signal);
		return {
			status: observedResult.status,
			communicationId: runtime.communicationId,
			communicationFile: runtime.communicationFile,
			paneId: runtime.paneId,
			agent: runtime.agent,
			agentSession: runtime.session,
			completion,
			error: observedResult.error ?? completion.summary,
		};
	}

	/** Captures exact pre-relay output and persists its baseline without exposing raw text.
	 * TEST:engine.test.ts[DelegateEngine completes a leaf only after exact checkpoint and DONE contract]
	 */
	private async captureBaseline(runtime: LeafRuntime, owner: "parent" | "coordinator", signal?: AbortSignal): Promise<AgentTurnBaseline> {
		try {
			const snapshot = await this.dependencies.gateway.getAgent(runtime.agent, signal);
			if (snapshot.agent !== runtime.agent || snapshot.paneId !== runtime.paneId || snapshot.workspaceId !== runtime.workspaceId || !snapshot.agentSession || !runtime.session || !sameSession(snapshot.agentSession, runtime.session)) {
				throw new BaselineCaptureError("pre-relay exact agent, pane, workspace, or session identity could not be verified");
			}
			if (snapshot.status === "closed") throw new BaselineCaptureError("pre-relay target is already closed");
			const output = (await this.dependencies.gateway.readAgent(runtime.agent, signal)).text;
			const baseline: AgentTurnBaseline = {
				fingerprint: hashDebugText(output) ?? "",
				length: output.length,
				capturedAt: new Date().toISOString(),
				source: "terminal",
			};
			runtime.baseline = baseline;
			await appendEvent(runtime.communicationFile, event("pre-relay-checkpoint", owner, runtime, {
				operation: "baseline",
				accepted: true,
				transportStatus: snapshot.status,
				observedTransportStatus: snapshot.status,
				paneId: snapshot.paneId,
				agent: snapshot.agent,
				baselineFingerprint: baseline.fingerprint,
				baselineLength: baseline.length,
				baselineCapturedAt: baseline.capturedAt,
			}, undefined, snapshot.agentSession));
			return baseline;
		} catch (error) {
			await appendEvent(runtime.communicationFile, event("pre-relay-checkpoint", owner, runtime, {
				operation: "baseline",
				accepted: "unknown",
				transportStatus: "unknown",
				error: error instanceof Error ? error.message : String(error),
			}, undefined, runtime.session)).catch(() => undefined);
			if (signal?.aborted || isHerdrCommandTimeout(error) && runtime.deadlineAt !== undefined && Date.now() >= runtime.deadlineAt) throw error;
			if (error instanceof BaselineCaptureError) throw error;
			if (isDefinitivelyClosedAgentError(error)) throw new BaselineCaptureError("Herdr closed the exact target before relay baseline capture");
			throw new BaselineCaptureError(`pre-relay baseline capture failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Submits a pointer-only relay with one retry only after explicit pre-delivery proof.
	 * TEST:engine.test.ts[DelegateEngine retries an explicitly unsent relay once]
	 */
	private async submitRelay(runtime: LeafRuntime, relay: string, owner: "parent" | "coordinator", messageId: string, signal?: AbortSignal): Promise<void> {
		for (let submitAttempt = 1; submitAttempt <= 2; submitAttempt += 1) {
			const remaining = runtime.deadlineAt === undefined ? undefined : runtime.deadlineAt - Date.now();
			if (remaining !== undefined && remaining <= 0) throw new Error("delegate stage deadline expired before relay");
			try {
				runtime.submittedAt ??= new Date().toISOString();
				await this.dependencies.gateway.prompt({ target: runtime.agent, text: relay, wait: false, timeoutMs: remaining === undefined ? undefined : Math.max(1, remaining), signal });
				await appendEvent(runtime.communicationFile, event("checkpoint", owner, runtime, {
					operation: "relay-submitted",
					accepted: true,
					deliveryState: "SENT",
					transportStatus: "unknown",
					baselineFingerprint: runtime.baseline?.fingerprint,
					baselineLength: runtime.baseline?.length,
					relayMessageId: messageId,
					submitAttempt,
				}, undefined, runtime.session));
				return;
			} catch (error) {
				const deliveryState = deliveryStateFor(error);
				await appendEvent(runtime.communicationFile, event("checkpoint", owner, runtime, {
					operation: "relay-submitted",
					accepted: deliveryState === "NOT_SENT" ? false : "unknown",
					deliveryState,
					transportStatus: "unknown",
					baselineFingerprint: runtime.baseline?.fingerprint,
					baselineLength: runtime.baseline?.length,
					relayMessageId: messageId,
					submitAttempt,
					error: error instanceof Error ? error.message : String(error),
				}, undefined, runtime.session)).catch(() => undefined);
				if (deliveryState === "NOT_SENT" && submitAttempt === 1) {
					await appendEvent(runtime.communicationFile, event("relay-retry", owner, runtime, {
						operation: "relay-retry",
						deliveryState,
						relayMessageId: messageId,
						submitAttempt: submitAttempt + 1,
					}, undefined, runtime.session));
					continue;
				}
				// Unknown delivery is observed by the same monitor; no second child or relay is created.
				return;
			}
		}
	}

	/** Falls back to a local exact Pi session only after terminal capture cannot prove the current relay.
	 *
	 * @param runtime Current exact child-pane and session context.
	 * @param relayMessageId Parent-generated identity for this exact child relay.
	 * @returns Parsed session completion for the current relay, otherwise undefined.
	 * TEST:engine.test.ts[DelegateEngine falls back to the exact Pi session when Herdr terminal rows wrap]
	 */
	private async capturePiSessionCompletion(runtime: LeafRuntime, relayMessageId: string): Promise<CapturedCompletion | undefined> {
		if (!isReadablePiSession(runtime.session)) return undefined;
		try {
			const output = await readFile(runtime.session.value, "utf8");
			const completion = parsePiRelayCompletion(output, runtime.communicationFile, relayMessageId);
			if (!completion) return undefined;
			await debug.log("leaf.output.session-contract-found", {
				communicationId: runtime.communicationId,
				agent: runtime.agent,
				session: runtime.session,
				length: output.length,
				sha256: hashDebugText(output),
			}, "trace");
			return { completion, attempts: 0, source: "pi-session" };
		} catch (error) {
			await debug.log("leaf.output.session-unavailable", {
				communicationId: runtime.communicationId,
				agent: runtime.agent,
				session: runtime.session,
				error: debugError(error),
			}, "trace");
			return undefined;
		}
	}

	/** Reuses an open exact-session pane and blocks on unknown or mismatched transport state. */
	private async reuseExistingPane(runtime: LeafRuntime, request: DelegateRequest, owner: "parent" | "coordinator", signal?: AbortSignal): Promise<HerdrAgentSnapshot | undefined> {
		if (!request.previousCommunication || !request.previousSession || !request.previousAgent) return undefined;
		try {
			const snapshot = await this.dependencies.gateway.getAgent(request.previousAgent, signal);
			if (snapshot.status === "unknown" || !snapshot.agentSession || !sameSession(snapshot.agentSession, request.previousSession)) {
				throw new Error("previous stage pane is open but exact session metadata is missing or mismatched");
			}
			if (!snapshot.workspaceId || snapshot.workspaceId !== runtime.workspaceId) throw new Error("previous stage pane belongs to another or unidentified Herdr workspace");
			runtime.agent = snapshot.agent;
			runtime.paneId = snapshot.paneId;
			runtime.session = snapshot.agentSession;
			await appendEvent(runtime.communicationFile, event("checkpoint", owner, runtime, {
				transportStatus: snapshot.status,
				paneId: snapshot.paneId,
				agent: snapshot.agent,
				cwd: snapshot.cwd,
				reusedExactSession: true,
			}, undefined, snapshot.agentSession));
			return snapshot;
		} catch (error) {
			if (isDefinitivelyClosedAgentError(error)) return undefined;
			throw error;
		}
	}

	/**
	 * Applies the configured completion disposition only after a semantic DONE contract is durable.
	 *
	 * @param runtime Exact child runtime retained from either the original run or a same-session reconciliation.
	 * @param completion Parsed semantic completion contract.
	 * @param owner Parent or coordinator responsible for the pane-disposition event.
	 * @param signal Optional cancellation signal forwarded to pane mutations.
	 * @returns DONE with the applied disposition, or PARTIAL when the disposition itself cannot be confirmed.
	 */
	private async completeDone(
		runtime: LeafRuntime,
		completion: CompletionContract,
		owner: "parent" | "coordinator",
		signal?: AbortSignal,
	): Promise<DelegateResult> {
		const disposition = planPaneDisposition(runtime.panePolicy, runtime.communicationId, true);
		await debug.log("leaf.disposition.start", {
			communicationId: runtime.communicationId,
			policy: disposition.policy,
			paneId: runtime.paneId,
			tabLabel: disposition.tabLabel,
		}, "debug");
		try {
			const applyDisposition = async (): Promise<void> => {
				if (disposition.policy === "close") await this.dependencies.gateway.closePane(runtime.paneId, signal);
				if (disposition.policy === "new-tab") {
					const moved = await this.dependencies.gateway.movePane({
						paneId: runtime.paneId,
						newTab: true,
						tabLabel: disposition.tabLabel!,
						workspaceId: runtime.workspaceId,
						focus: false,
						signal,
					});
					await appendEvent(runtime.communicationFile, event("pane-disposition", owner, runtime, {
						policy: disposition.policy,
						tabLabel: disposition.tabLabel,
						tabId: moved.tabId,
						paneId: runtime.paneId,
					}));
				} else {
					await appendEvent(runtime.communicationFile, event("pane-disposition", owner, runtime, {
						policy: disposition.policy,
						paneId: runtime.paneId,
					}));
				}
			};
			if (runtime.layoutLock) await runtime.layoutLock(applyDisposition);
			else await applyDisposition();
		} catch (error) {
			await debug.log("leaf.disposition.failed", { communicationId: runtime.communicationId, policy: disposition.policy, paneId: runtime.paneId, error: debugError(error) }, "warn");
			return { ...failureResult(runtime, "PARTIAL", error), completion };
		}
		await debug.log("leaf.disposition.done", { communicationId: runtime.communicationId, policy: disposition.policy, paneId: runtime.paneId, tabLabel: disposition.tabLabel }, "debug");
		return {
			status: "DONE",
			communicationId: runtime.communicationId,
			communicationFile: runtime.communicationFile,
			paneId: runtime.paneId,
			agent: runtime.agent,
			agentSession: runtime.session,
			completion,
			paneDisposition: disposition,
		};
	}

	/** Runs the shared exact-session monitor and commits one semantic observation result.
	 * TEST:engine.test.ts[DelegateEngine completes a leaf only after exact checkpoint and DONE contract]
	 */
	private async waitAndResolve(runtime: LeafRuntime, timeoutMs: number, owner: "parent" | "coordinator", relayMessageId: string, signal?: AbortSignal): Promise<DelegateResult> {
		if (!runtime.baseline || !runtime.session) return failureResult(runtime, "BLOCKED", "monitor requires an exact pre-relay baseline and session");
		const monitorInput: AgentTurnObservationInput = {
			target: runtime.agent,
			paneId: runtime.paneId,
			workspaceId: runtime.workspaceId,
			transactionId: runtime.transaction,
			stageId: runtime.stageId ?? runtime.stageRole,
			stageOccurrence: runtime.stageOccurrence,
			attempt: runtime.attempt ?? 1,
			fencingToken: runtime.fencingToken,
			executionFence: runtime.executionFence,
			expectedSession: runtime.session,
			communicationFile: runtime.communicationFile,
			relayMessageId,
			baseline: runtime.baseline,
			deadlineAt: new Date(runtime.deadlineAt ?? Date.now() + timeoutMs).toISOString(),
			submittedAt: runtime.submittedAt ?? new Date().toISOString(),
			owner,
			requireRelayAnchor: runtime.requireRelayAnchor,
			signal,
		};
		const monitor = new AgentTurnMonitor({
			gateway: this.dependencies.gateway,
			sleep: this.dependencies.sleep,
			captureFallback: async (input) => {
				const captured = await this.capturePiSessionCompletion(runtime, input.relayMessageId);
				return captured ? { completion: captured.completion, source: "pi-session" as const, attempts: captured.attempts } : undefined;
			},
			onObservation: async (observation) => {
				await appendEvent(runtime.communicationFile, event("observation", "child-output-capture", runtime, {
					operation: "observe",
					transportStatus: observation.transportStatus,
					readAttempt: observation.readAttempt,
					outputFingerprint: observation.outputFingerprint,
					outputLength: observation.outputLength,
					postSubmit: observation.postSubmit,
					relayAnchor: observation.relayAnchor,
				}, undefined, observation.agentSession));
			},
		});
		const observed = await monitor.observe(monitorInput);
		if (observed.status !== "BLOCKED") {
			runtime.paneId = observed.paneId;
			runtime.agent = observed.agent;
			runtime.session = observed.agentSession;
		}
		await appendEvent(runtime.communicationFile, event("result", "child-output-capture", runtime, {
			status: observed.status,
			operation: "observe",
			accepted: true,
			observedTransportStatus: observed.transportStatus,
			captureSource: observed.captureSource,
			captureAttempt: observed.observations,
			relayMessageId,
			resultKey: observed.resultKey,
			summary: observed.completion?.summary ?? observed.error,
			changedFiles: observed.completion?.changedFiles,
			validation: observed.completion?.validation,
			risks: observed.completion?.risks,
		}, undefined, observed.agentSession));
		if (observed.status === "DONE" && observed.completion && isSemanticDone(observed.completion)) return this.completeDone(runtime, observed.completion, owner, signal);
		return {
			status: observed.status,
			communicationId: runtime.communicationId,
			communicationFile: runtime.communicationFile,
			paneId: observed.paneId,
			agent: observed.agent,
			agentSession: observed.agentSession,
			completion: observed.completion,
			error: observed.error ?? observed.completion?.summary,
		};
	}
}
