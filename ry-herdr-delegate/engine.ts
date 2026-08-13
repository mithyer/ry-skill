import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { buildFinalAgentArgs } from "./args.ts";
import { resolveAgentProfile, type ConfigCapabilities } from "./config.ts";
import { debug, debugError, hashDebugText } from "./debug.ts";
import { planPaneDisposition } from "./pane-policy.ts";
import { appendEvent, communicationIdFromPath, createEventLog, createEventLogEvent, readEventLog } from "./records.ts";
import { errorCompletionContract, isSemanticDone, parseCompletionContract } from "./result.ts";
import type {
	CompletionContract,
	DelegateConfig,
	DelegateContext,
	DelegateRequest,
	DelegateResult,
	HerdrAgentSnapshot,
	HerdrGateway,
	JsonlEvent,
	NewJsonlEvent,
	PanePolicy,
	SemanticStatus,
	SessionIdentity,
} from "./types.ts";

/** Maximum number of automatic continuation attempts for an unfinished leaf. */
const MAX_CONTINUATIONS = 3;

/** Maximum terminal-output captures before reporting an incomplete child completion contract. */
const MAX_OUTPUT_CAPTURE_ATTEMPTS = 5;

/** Delay between terminal-output rereads while Herdr refreshes a child TUI snapshot. */
const OUTPUT_CAPTURE_RETRY_MS = 250;

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

/** Runtime-only context attached to one leaf engine execution. */
interface LeafRuntime {
	communicationFile: string;
	communicationId: string;
	transaction: string;
	stageRole: string;
	stageOccurrence: number;
	owner: "parent" | "coordinator";
	panePolicy: PanePolicy;
	cwd: string;
	workspaceId: string;
	agent: string;
	paneId: string;
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
	runtime: Pick<LeafRuntime, "transaction" | "stageRole" | "stageOccurrence">,
	payload: Record<string, unknown>,
	messageId?: string,
	agentSession?: SessionIdentity,
): NewJsonlEvent {
	return {
		schemaVersion: 1,
		eventId: `${type}-${randomUUID()}`,
		timestamp: new Date().toISOString(),
		type,
		actor,
		transaction: runtime.transaction,
		stageRole: runtime.stageRole,
		stageOccurrence: runtime.stageOccurrence,
		...(messageId ? { messageId } : {}),
		...(agentSession ? { agentSession } : {}),
		payload,
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
		"Return the required completion contract.",
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
	 * TEST:engine.test.ts[DelegateEngine returns DONE only after completion contract and checkpoint]
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
		if (request.previousSession && !request.previousCommunication) throw new Error("exact stage continuation requires its previous communication log");
		const communicationFile = request.communicationFile ?? request.previousCommunication ?? communicationPath(communicationDirectory, role, id());
		const runtime: LeafRuntime = {
			communicationFile,
			communicationId: communicationIdFromPath(communicationFile),
			transaction,
			stageRole: role,
			stageOccurrence,
			owner,
			panePolicy: profile.panePolicy,
			cwd: overrides.cwd ?? context.cwd,
			workspaceId: context.workspaceId,
			agent: request.previousAgent ?? `${role}-${id()}`,
			paneId: request.previousPaneId ?? "pending",
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
			const existingAgent = await this.reuseExistingPane(runtime, request, owner);
			if (existingAgent) {
				await debug.log("leaf.session.reused", {
					communicationId: runtime.communicationId,
					agent: existingAgent.agent,
					paneId: existingAgent.paneId,
					status: existingAgent.status,
					agentSession: existingAgent.agentSession,
				}, "debug");
				await this.relayAndAwaitTurn(existingAgent.agent, relay, profile.timeoutMs, signal);
				await debug.log("leaf.relay.sent", { communicationId: runtime.communicationId, agent: existingAgent.agent, paneId: existingAgent.paneId, messageType, waitForTurn: true }, "debug");
				return await this.waitAndResolve(runtime, profile.timeoutMs, owner, messageId, signal);
			}
			await debug.log("leaf.pane.split.start", { communicationId: runtime.communicationId, sourcePaneId: context.sourcePaneId, cwd: runtime.cwd }, "debug");
			const finalArgs = buildFinalAgentArgs(profile, request.previousSession);
			const pane = await this.dependencies.gateway.splitPane({
				sourcePaneId: context.sourcePaneId,
				direction: "right",
				cwd: runtime.cwd,
				env: profile.env,
				focus: false,
			});
			runtime.paneId = pane.paneId;
			await debug.log("leaf.pane.split.result", { communicationId: runtime.communicationId, paneId: pane.paneId, workspaceId: pane.workspaceId, tabId: pane.tabId }, "debug");
			const started = await this.dependencies.gateway.startAgent({
				name: runtime.agent,
				kind: profile.kind,
				paneId: pane.paneId,
				agentArgs: finalArgs,
			});
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
			}, undefined, observedSession));
			await this.relayAndAwaitTurn(started.agent, relay, profile.timeoutMs, signal);
			await debug.log("leaf.relay.sent", { communicationId: runtime.communicationId, agent: started.agent, paneId: started.paneId, messageType, waitForTurn: true }, "debug");
			return await this.waitAndResolve(runtime, profile.timeoutMs, owner, messageId, signal);
		} catch (error) {
			await debug.log("leaf.run.failed", { communicationId: runtime.communicationId, transaction: runtime.transaction, stageRole: runtime.stageRole, error: debugError(error) }, "error");
			await appendEvent(communicationFile, event("error", owner, runtime, { error: error instanceof Error ? error.message : String(error) })).catch(() => undefined);
			return failureResult(runtime, "ERROR", error);
		}
	}

	/**
	 * Relays a handoff and waits for Herdr to observe a post-submission state transition.
	 *
	 * A standalone `agent wait` accepts an already-idle child immediately. Waiting in the
	 * prompt command prevents output capture before the submitted child turn actually runs.
	 *
	 * @param agent Unique Herdr child-agent target.
	 * @param relay Pointer-only JSONL handoff envelope.
	 * @param timeoutMs Resolved child-turn deadline.
	 * @param signal Optional cancellation signal for the Herdr CLI process.
	 * @returns A promise that settles once Herdr sees the submitted child turn finish.
	 * TEST:engine.test.ts[DelegateEngine completes a leaf only after exact checkpoint and DONE contract]
	 */
	private async relayAndAwaitTurn(agent: string, relay: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		await this.dependencies.gateway.prompt({ target: agent, text: relay, wait: true, timeoutMs, signal });
	}

	/**
	 * Captures a child terminal snapshot until a completion contract is visible or the bounded refresh budget is exhausted.
	 * An exact local Pi session is checked after each failed terminal parse to bypass visual row wrapping.
	 *
	 * @param runtime Current exact child-pane and session context.
	 * @param relayMessageId Parent-generated identity for this exact child relay.
	 * @returns The first parsed completion contract, or the final parser failure with capture metadata.
	 * TEST:engine.test.ts[DelegateEngine rereads a stale terminal snapshot before parsing the completion contract]
	 * TEST:engine.test.ts[DelegateEngine falls back to the exact Pi session when Herdr terminal rows wrap]
	 */
	private async captureCompletion(runtime: LeafRuntime, relayMessageId: string): Promise<CapturedCompletion> {
		const sleep = this.dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
		let completion: CompletionContract | undefined;
		for (let attempt = 1; attempt <= MAX_OUTPUT_CAPTURE_ATTEMPTS; attempt += 1) {
			const output = (await this.dependencies.gateway.readAgent(runtime.agent)).text;
			try {
				completion = parseCompletionContract(output);
				await debug.log("leaf.output.contract-found", {
					communicationId: runtime.communicationId,
					agent: runtime.agent,
					attempt,
					length: output.length,
					sha256: hashDebugText(output),
				}, "trace");
				return { completion, attempts: attempt, source: "terminal" };
			} catch (error) {
				completion = errorCompletionContract(error);
				await debug.log("leaf.output.contract-missing", {
					communicationId: runtime.communicationId,
					agent: runtime.agent,
					attempt,
					maxAttempts: MAX_OUTPUT_CAPTURE_ATTEMPTS,
					length: output.length,
					sha256: hashDebugText(output),
				}, attempt === MAX_OUTPUT_CAPTURE_ATTEMPTS ? "warn" : "trace");
				const sessionCompletion = await this.capturePiSessionCompletion(runtime, relayMessageId);
				if (sessionCompletion) return sessionCompletion;
				if (attempt < MAX_OUTPUT_CAPTURE_ATTEMPTS) await sleep(OUTPUT_CAPTURE_RETRY_MS);
			}
		}
		return { completion: completion!, attempts: MAX_OUTPUT_CAPTURE_ATTEMPTS, source: "terminal" };
	}

	/**
	 * Falls back to a local exact Pi session only after every terminal capture fails strict contract parsing.
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
	private async reuseExistingPane(runtime: LeafRuntime, request: DelegateRequest, owner: "parent" | "coordinator"): Promise<HerdrAgentSnapshot | undefined> {
		if (!request.previousCommunication || !request.previousSession || !request.previousAgent) return undefined;
		try {
			const snapshot = await this.dependencies.gateway.getAgent(request.previousAgent);
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
			if (isDefinitivelyClosedAgentLookup(error)) return undefined;
			throw error;
		}
	}

	/** Waits for settled child states, checkpointing every return before semantic validation. */
	private async waitAndResolve(runtime: LeafRuntime, timeoutMs: number, owner: "parent" | "coordinator", relayMessageId: string, signal?: AbortSignal): Promise<DelegateResult> {
		let continuations = 0;
		while (true) {
			if (signal?.aborted) {
				await debug.log("leaf.wait.aborted", { communicationId: runtime.communicationId, agent: runtime.agent, paneId: runtime.paneId }, "warn");
				return failureResult(runtime, "PARTIAL", "delegate operation was aborted");
			}
			await debug.log("leaf.wait.start", {
				communicationId: runtime.communicationId,
				agent: runtime.agent,
				paneId: runtime.paneId,
				timeoutMs,
				continuations,
			}, "debug");
			let snapshot;
			try {
				snapshot = await this.dependencies.gateway.waitFor({ target: runtime.agent, until: ["idle", "done", "blocked", "unknown"], timeoutMs, signal });
				runtime.paneId = snapshot.paneId;
				await debug.log("leaf.wait.result", {
					communicationId: runtime.communicationId,
					agent: snapshot.agent,
					paneId: snapshot.paneId,
					status: snapshot.status,
					agentSession: snapshot.agentSession,
				}, "debug");
				if (!snapshot.agentSession || !runtime.session || !sameSession(runtime.session, snapshot.agentSession)) {
					await debug.log("leaf.wait.session-mismatch", {
						communicationId: runtime.communicationId,
						agent: snapshot.agent,
						paneId: snapshot.paneId,
						expectedAgentSession: runtime.session,
						observedAgentSession: snapshot.agentSession,
					}, "warn");
					await appendEvent(runtime.communicationFile, event("checkpoint", owner, runtime, {
						transportStatus: snapshot.status,
						paneId: snapshot.paneId,
						agent: snapshot.agent,
						error: "Herdr wait returned missing or mismatched exact agent_session metadata",
					}));
					return failureResult(runtime, "BLOCKED", "Herdr wait returned missing or mismatched exact agent_session metadata");
				}
				runtime.session = snapshot.agentSession;
				await appendEvent(runtime.communicationFile, event("checkpoint", owner, runtime, {
					transportStatus: snapshot.status,
					paneId: snapshot.paneId,
					agent: snapshot.agent,
					cwd: snapshot.cwd,
				}, undefined, snapshot.agentSession));
			} catch (error) {
				await debug.log("leaf.wait.failed", {
					communicationId: runtime.communicationId,
					agent: runtime.agent,
					paneId: runtime.paneId,
					error: debugError(error),
				}, "warn");
				await appendEvent(runtime.communicationFile, event("checkpoint", owner, runtime, {
					transportStatus: "unknown",
					error: error instanceof Error ? error.message : String(error),
				})).catch(() => undefined);
				return failureResult(runtime, "PARTIAL", error);
			}
			if (snapshot.status === "unknown") {
				await debug.log("leaf.wait.unknown", { communicationId: runtime.communicationId, agent: runtime.agent, paneId: runtime.paneId }, "warn");
				return failureResult(runtime, "PARTIAL", "Herdr returned unknown pane state");
			}
			let captured: CapturedCompletion;
			try {
				captured = await this.captureCompletion(runtime, relayMessageId);
				await debug.log("leaf.output.read", {
					communicationId: runtime.communicationId,
					agent: runtime.agent,
					attempts: captured.attempts,
					source: captured.source,
					semanticStatus: captured.completion.status,
				}, "trace");
			} catch (error) {
				await debug.log("leaf.output.read-failed", { communicationId: runtime.communicationId, agent: runtime.agent, error: debugError(error) }, "warn");
				return failureResult(runtime, "PARTIAL", error);
			}
			const completion = captured.completion;
			await appendEvent(runtime.communicationFile, event("result", "child-output-capture", runtime, {
				status: completion.status,
				summary: completion.summary,
				changedFiles: completion.changedFiles,
				validation: completion.validation,
				risks: completion.risks,
			}, undefined, runtime.session));
			await debug.log("leaf.completion.parsed", {
				communicationId: runtime.communicationId,
				transportStatus: snapshot.status,
				semanticStatus: completion.status,
				hasSummary: Boolean(completion.summary),
				hasValidation: Boolean(completion.validation),
				changedFileCount: completion.changedFiles?.length ?? 0,
				riskCount: completion.risks?.length ?? 0,
			}, "debug");
			if (snapshot.status === "blocked") {
				await debug.log("leaf.completion.blocked", { communicationId: runtime.communicationId, agent: runtime.agent, paneId: runtime.paneId, semanticStatus: completion.status }, "warn");
				const blockedCompletion = completion.status === "ERROR" ? { ...completion, status: "BLOCKED" as const } : completion;
				return {
					status: "BLOCKED",
					communicationId: runtime.communicationId,
					communicationFile: runtime.communicationFile,
					paneId: runtime.paneId,
					agent: runtime.agent,
					agentSession: runtime.session,
					completion: blockedCompletion,
					error: blockedCompletion.summary ?? "Child transport is blocked",
				};
			}
			if (isSemanticDone(completion)) {
				const disposition = planPaneDisposition(runtime.panePolicy, runtime.communicationId, true);
				await debug.log("leaf.disposition.start", {
					communicationId: runtime.communicationId,
					policy: disposition.policy,
					paneId: runtime.paneId,
					tabLabel: disposition.tabLabel,
				}, "debug");
				try {
					if (disposition.policy === "close") await this.dependencies.gateway.closePane(runtime.paneId);
					if (disposition.policy === "new-tab") {
						const createdTab = await this.dependencies.gateway.createTab({
							workspaceId: runtime.workspaceId,
							cwd: runtime.cwd,
							label: disposition.tabLabel!,
							focus: false,
						});
						const moved = await this.dependencies.gateway.movePane({
							paneId: runtime.paneId,
							tabId: createdTab.tabId,
							workspaceId: runtime.workspaceId,
							focus: false,
						});
						await appendEvent(runtime.communicationFile, event("pane-disposition", owner, runtime, {
							policy: disposition.policy,
							tabLabel: disposition.tabLabel,
							tabId: moved.tabId ?? createdTab.tabId,
							paneId: runtime.paneId,
						}));
					} else {
						await appendEvent(runtime.communicationFile, event("pane-disposition", owner, runtime, {
							policy: disposition.policy,
							paneId: runtime.paneId,
						}));
					}
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
			await debug.log("leaf.completion.incomplete", {
				communicationId: runtime.communicationId,
				semanticStatus: completion.status,
				agent: runtime.agent,
				paneId: runtime.paneId,
			}, completion.status === "ERROR" ? "error" : "warn");
			return {
				status: completion.status,
				communicationId: runtime.communicationId,
				communicationFile: runtime.communicationFile,
				paneId: runtime.paneId,
				agent: runtime.agent,
				agentSession: runtime.session,
				completion,
				error: completion.summary,
			};
		}
	}
}

/** Recognizes a Herdr lookup failure that proves the prior agent target is closed. */
function isDefinitivelyClosedAgentLookup(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { code?: unknown; message?: unknown; stderr?: unknown };
	if (candidate.code === 404 || candidate.code === "ENOENT") return true;
	const text = [candidate.message, candidate.stderr].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
	return text.includes("agent_not_found") || (text.includes("agent target") && text.includes("not found")) || text.includes("not found") || text.includes("unknown agent") || text.includes("no such agent");
}

/** Builds a fixed continuation envelope after a blocked or incomplete result. */
function buildContinuationEnvelope(file: string, runtime: LeafRuntime, status: SemanticStatus): string {
	return [
		`COMMUNICATION FILE: ${file}`,
		`MESSAGE SEQ: latest`,
		`MESSAGE LINES: latest`,
		`MESSAGE LINE COUNT: 1`,
		`MESSAGE ID: continuation-${runtime.communicationId}-${status}`,
		"MESSAGE TYPE: continuation",
		"",
		"Read the latest checkpoint and result events before continuing the same stage.",
		"Resolve only routine blockers already covered by the recorded task and return the full completion contract.",
	].join("\n");
}
