import { hashDebugText } from "./debug.ts";
import { errorCompletionContract, parseCompletionContract } from "./result.ts";
import type {
	AgentTransportStatus,
	CompletionContract,
	HerdrAgentSnapshot,
	HerdrGateway,
	SessionIdentity,
} from "./types.ts";

/** Evidence captured immediately before a relay is submitted. */
export interface AgentTurnBaseline {
	/** Hash of the terminal text observed before this relay. */
	fingerprint: string;
	/** Length of the pre-relay terminal text. */
	length: number;
	/** Capture timestamp used to order baseline and relay events. */
	capturedAt: string;
	/** Source that produced the baseline snapshot. */
	source: "terminal" | "pi-session";
}

/** Redacted observation data persisted by the parent/coordinator writer. */
export interface AgentTurnObservation {
	/** Transport state at the observation point. */
	transportStatus: AgentTransportStatus;
	/** One-based terminal read attempt. */
	readAttempt: number;
	/** Hash of the observed terminal text. */
	outputFingerprint: string;
	/** Length of the observed terminal text, omitted when the read itself failed. */
	outputLength?: number;
	/** Whether the output differs from the pre-relay baseline. */
	postSubmit: boolean;
	/** Whether a relay marker was visible in the captured output. */
	relayAnchor: boolean;
	/** Exact child identity observed by Herdr. */
	agentSession: SessionIdentity;
	/** Pane identity observed by Herdr. */
	paneId: string;
}

/** Input contract for one exact-session external-agent observation loop. */
export interface AgentTurnObservationInput {
	/** Unique Herdr agent target. */
	target: string;
	/** Pane expected to contain the target. */
	paneId: string;
	/** Workspace expected to contain the pane. */
	workspaceId: string;
	/** Transaction identity used by the JSONL record. */
	transactionId: string;
	/** Optional pipeline stage identity. */
	stageId?: string;
	/** Optional pipeline stage occurrence. */
	stageOccurrence?: number;
	/** Durable attempt number. */
	attempt: number;
	/** Reservation fence for a pipeline stage. */
	fencingToken?: string;
	/** Parent/coordinator execution fence for the result key. */
	executionFence: string;
	/** Exact session identity that must remain unchanged. */
	expectedSession: SessionIdentity;
	/** Communication log used to identify the relay. */
	communicationFile: string;
	/** Parent-generated relay message identity. */
	relayMessageId: string;
	/** Pre-relay output baseline. */
	baseline: AgentTurnBaseline;
	/** Absolute overall stage deadline. */
	deadlineAt: string;
	/** Timestamp when the logical relay submission began. */
	submittedAt: string;
	/** Parent or coordinator that owns the observation. */
	owner: "parent" | "coordinator";
	/** Continuations require an explicit current relay marker in terminal output. */
	requireRelayAnchor?: boolean;
	/** Optional cancellation signal. */
	signal?: AbortSignal;
}

/** Completion evidence returned by a source-specific fallback. */
export interface AgentTurnFallbackCompletion {
	/** Parsed completion contract. */
	completion: CompletionContract;
	/** Source used by the fallback. */
	source: "pi-session";
	/** Number of source-specific reads performed. */
	attempts: number;
}

/** Result returned after exact transport and semantic observation. */
export interface AgentTurnObservationResult {
	/** Semantic result derived from the current relay or transport boundary. */
	status: "DONE" | "BLOCKED" | "PARTIAL" | "ERROR";
	/** Last exact transport state observed. */
	transportStatus: AgentTransportStatus;
	/** Parsed completion contract when one was found. */
	completion?: CompletionContract;
	/** Exact session observed at the result boundary. */
	agentSession: SessionIdentity;
	/** Pane observed at the result boundary. */
	paneId: string;
	/** Actual Herdr target observed at the result boundary. */
	agent: string;
	/** Relay identity associated with the result. */
	relayMessageId: string;
	/** Attempt identity associated with the result. */
	attempt: number;
	/** Reservation fence associated with the result. */
	fencingToken?: string;
	/** Parent/coordinator execution fence associated with the result. */
	executionFence: string;
	/** Stable idempotency identity for the logical result. */
	resultKey: string;
	/** Number of terminal observations performed. */
	observations: number;
	/** Completion source when a contract was parsed. */
	captureSource?: "terminal" | "pi-session";
	/** Redacted human-readable failure explanation. */
	error?: string;
}

/** Dependencies and extension seams for the shared monitor. */
export interface AgentTurnMonitorDependencies {
	/** Herdr transport boundary. */
	gateway: HerdrGateway;
	/** Delay between bounded observations. */
	sleep?: (milliseconds: number) => Promise<void>;
	/** Poll interval used when Herdr returns an idle or unknown hint. */
	pollIntervalMs?: number;
	/** Maximum read attempts before returning PARTIAL. */
	maxAttempts?: number;
	/** Optional exact-session completion fallback, such as the Pi JSONL reader. */
	captureFallback?: (input: AgentTurnObservationInput) => Promise<AgentTurnFallbackCompletion | undefined>;
	/** Parent/coordinator callback that persists redacted observation metadata. */
	onObservation?: (observation: AgentTurnObservation) => Promise<void> | void;
}

/** Builds an unambiguous idempotency key from transaction and execution identity.
 *
 * @param input Transaction, stage, attempt, fence, and relay identity.
 * @returns Stable JSON-encoded result identity.
 * TEST:agent-monitor.test.ts[AgentTurnMonitor waits past idle until a post-relay DONE contract]
 */
export function buildResultKey(input: Pick<AgentTurnObservationInput, "transactionId" | "stageId" | "stageOccurrence" | "attempt" | "executionFence" | "relayMessageId">): string {
	return JSON.stringify([
		input.transactionId,
		input.stageId ?? "direct-leaf",
		input.stageOccurrence ?? 1,
		input.attempt,
		input.executionFence,
		input.relayMessageId,
	]);
}

/** Compares the complete exact session triple.
 *
 * @param left First exact session identity.
 * @param right Second exact session identity.
 * @returns Whether kind, source, and value all match.
 * TEST:agent-monitor.test.ts[AgentTurnMonitor blocks a changed pane or session]
 */
export function sameAgentSession(left: SessionIdentity, right: SessionIdentity): boolean {
	return left.kind === right.kind && left.source === right.source && left.value === right.value;
}

/** Recognizes Herdr responses that definitively prove an agent target is closed.
 *
 * @param error Unknown gateway failure or response error.
 * @returns Whether the error proves the exact agent target is closed.
 * TEST:agent-monitor.test.ts[AgentTurnMonitor maps definitive closure to BLOCKED]
 */
export function isDefinitivelyClosedAgentError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { code?: unknown; herdrCode?: unknown; message?: unknown; stderr?: unknown };
	if (candidate.code === 404 || candidate.code === "ENOENT" || candidate.herdrCode === "agent_not_found") return true;
	const text = [candidate.message, candidate.stderr].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
	return text.includes("agent_not_found") || text.includes("agent target") && text.includes("not found") || text.includes("unknown agent") || text.includes("no such agent");
}

/** Recognizes a gateway-owned timeout without treating a bounded poll timeout as parent cancellation. */
function isGatewayTimeout(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as { timedOut?: unknown }).timedOut === true);
}

/** Detects child-side interruption text without persisting the raw output. */
function isInterruptedOutput(text: string): boolean {
	return /conversation interrupted/i.test(text)
		|| /<turn_aborted\b/i.test(text)
		|| /previous turn was interrupted on purpose/i.test(text);
}

/** Converts an interrupted child into a bounded PARTIAL completion contract. */
function interruptedCompletion(): CompletionContract {
	return { ...errorCompletionContract(new Error("Child conversation was interrupted before completion contract")), status: "PARTIAL" };
}

/** Builds a whitespace-tolerant pattern for a terminal-wrapped relay marker. */
function relayMarkerPattern(label: string, value: string): RegExp {
	const compactMarker = `${label}:${value}`.replace(/\s+/g, "");
	const pattern = [...compactMarker].map((character) => `${character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`).join("");
	return new RegExp(pattern, "i");
}

/** Finds a relay marker even when terminal rendering inserts whitespace or line breaks. */
function findRelayMarker(text: string, label: string, value: string): number {
	return text.search(relayMarkerPattern(label, value));
}

/** Returns whether a capture contains both current relay pointers.
 * TEST:agent-monitor.test.ts[AgentTurnMonitor accepts terminal-wrapped current relay markers]
 */
function hasRelayAnchor(text: string, input: AgentTurnObservationInput): boolean {
	return relayMarkerPattern("MESSAGE ID", input.relayMessageId).test(text)
		&& relayMarkerPattern("COMMUNICATION FILE", input.communicationFile).test(text);
}

/** Narrows terminal parsing to the current relay and rejects visible foreign relay markers.
 * TEST:agent-monitor.test.ts[AgentTurnMonitor rejects a foreign relay marker despite changed output]
 */
function currentRelayOutput(text: string, input: AgentTurnObservationInput): string | undefined {
	const messageIndex = findRelayMarker(text, "MESSAGE ID", input.relayMessageId);
	const fileIndex = findRelayMarker(text, "COMMUNICATION FILE", input.communicationFile);
	const hasAnyMessageMarker = /MESSAGE\s*ID\s*:/i.test(text);
	if (input.requireRelayAnchor && !hasRelayAnchor(text, input)) return undefined;
	if (hasAnyMessageMarker && !hasRelayAnchor(text, input)) return undefined;
	if (messageIndex < 0 && fileIndex < 0) return text;
	if (messageIndex < 0 || fileIndex < 0) return undefined;
	return text.slice(Math.max(messageIndex, fileIndex));
}

/** Shared polling monitor that separates Herdr transport hints from semantic completion. */
export class AgentTurnMonitor {
	/** Monitor dependencies and deterministic test seams. */
	private readonly dependencies: AgentTurnMonitorDependencies;

	/**
	 * Creates an exact-session monitor.
	 *
	 * @param dependencies Herdr gateway, polling settings, fallback, and observation writer.
	 */
	constructor(dependencies: AgentTurnMonitorDependencies) {
		this.dependencies = dependencies;
	}

	/**
	 * Polls one external turn until a current completion contract or bounded terminal state is proven.
	 *
	 * @param input Exact pane/session, relay, baseline, attempt, fence, and deadline identity.
	 * @returns Semantic result with redacted observation counters and exact identity.
	 * TEST:agent-monitor.test.ts[AgentTurnMonitor waits past idle until a post-relay DONE contract]
	 */
	async observe(input: AgentTurnObservationInput): Promise<AgentTurnObservationResult> {
		const sleep = this.dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
		const pollIntervalMs = this.dependencies.pollIntervalMs ?? 250;
		const maxAttempts = this.dependencies.maxAttempts;
		const resultKey = buildResultKey(input);
		let observations = 0;
		let previousTransport: AgentTransportStatus | undefined;
		let previousFingerprint = input.baseline.fingerprint;
		let lastSnapshot: HerdrAgentSnapshot | undefined;
		let lastError: unknown;

		for (let attempt = 1; ; attempt += 1) {
			const remaining = Date.parse(input.deadlineAt) - Date.now();
			if (!Number.isFinite(remaining) || remaining <= 0) {
				return this.partialResult(input, resultKey, lastSnapshot, observations, lastError ?? new Error("external-agent observation deadline expired"));
			}
			if (input.signal?.aborted) {
				return this.partialResult(input, resultKey, lastSnapshot, observations, input.signal.reason ?? new Error("external-agent observation was aborted"));
			}

			let snapshot: HerdrAgentSnapshot | undefined;
			try {
				snapshot = await this.dependencies.gateway.waitFor({
					target: input.target,
					until: ["idle", "done", "blocked", "unknown"],
					timeoutMs: Math.max(1, Math.min(pollIntervalMs, remaining)),
					signal: input.signal,
				});
			} catch (error) {
				lastError = error;
				if (isDefinitivelyClosedAgentError(error)) return this.blockedResult(input, resultKey, lastSnapshot, observations, "Herdr closed the exact agent before a completion contract was observed");
				if (input.signal?.aborted) return this.partialResult(input, resultKey, lastSnapshot, observations, input.signal.reason ?? error);
				if (!isGatewayTimeout(error)) {
					try {
						snapshot = await this.dependencies.gateway.getAgent(input.target, input.signal);
					} catch (lookupError) {
						lastError = lookupError;
						if (isDefinitivelyClosedAgentError(lookupError)) return this.blockedResult(input, resultKey, lastSnapshot, observations, "Herdr closed the exact agent before a completion contract was observed");
					}
				}
			}

			if (!snapshot) {
				await sleep(Math.min(pollIntervalMs, Math.max(1, remaining)));
				continue;
			}
			lastSnapshot = snapshot;
			if (snapshot.agent !== input.target || snapshot.paneId !== input.paneId || snapshot.workspaceId !== input.workspaceId || !snapshot.agentSession || !sameAgentSession(snapshot.agentSession, input.expectedSession)) {
				return this.blockedResult(input, resultKey, snapshot, observations, "External-agent pane, workspace, or exact session identity changed");
			}
			if (snapshot.status === "closed") return this.blockedResult(input, resultKey, snapshot, observations, "Herdr closed the exact agent before a completion contract was observed");

			let output = "";
			try {
				output = (await this.dependencies.gateway.readAgent(input.target, input.signal)).text;
			} catch (error) {
				lastError = error;
				if (isDefinitivelyClosedAgentError(error)) return this.blockedResult(input, resultKey, snapshot, observations, "Herdr closed the exact agent while reading completion output");
				if (input.signal?.aborted) return this.partialResult(input, resultKey, snapshot, observations, input.signal.reason ?? error);
				await this.emitObservation(input, snapshot, attempt, previousTransport, previousFingerprint, previousFingerprint !== input.baseline.fingerprint, false, undefined);
				previousTransport = snapshot.status;
				await sleep(Math.min(pollIntervalMs, Math.max(1, remaining)));
				continue;
			}

			const outputFingerprint = hashDebugText(output) ?? "";
			const postSubmit = outputFingerprint !== input.baseline.fingerprint;
			const relayAnchor = hasRelayAnchor(output, input);
			observations += 1;
			await this.emitObservation(input, snapshot, attempt, previousTransport, previousFingerprint, postSubmit, relayAnchor, output);
			previousTransport = snapshot.status;
			previousFingerprint = outputFingerprint;

			let completion: CompletionContract | undefined;
			const relayOutput = postSubmit || relayAnchor ? currentRelayOutput(output, input) : undefined;
			if (relayOutput) {
				try {
					completion = parseCompletionContract(relayOutput);
				} catch (error) {
					lastError = error;
				}
			}
			if (!completion && this.dependencies.captureFallback) {
				const fallback = await this.dependencies.captureFallback(input);
				if (fallback) return this.resultFromCompletion(input, resultKey, snapshot, observations, fallback.completion, fallback.source);
			}
			if (completion) return this.resultFromCompletion(input, resultKey, snapshot, observations, completion, "terminal");
			const interruptionOutput = /MESSAGE ID:\s*\S+/.test(output) ? relayOutput : output;
			if (interruptionOutput && isInterruptedOutput(interruptionOutput)) return this.resultFromCompletion(input, resultKey, snapshot, observations, interruptedCompletion(), "terminal");
			if (snapshot.status === "blocked") return this.blockedResult(input, resultKey, snapshot, observations, "External agent is blocked without a parseable completion contract");
			if (maxAttempts !== undefined && attempt === maxAttempts) break;
			await sleep(Math.min(pollIntervalMs, Math.max(1, Date.parse(input.deadlineAt) - Date.now())));
		}

		return this.partialResult(input, resultKey, lastSnapshot, observations, lastError ?? new Error("completion contract was not observed before the monitor budget expired"));
	}

	/** Emits only transport/output metadata and never forwards raw child text. */
	private async emitObservation(
		input: AgentTurnObservationInput,
		snapshot: HerdrAgentSnapshot,
		readAttempt: number,
		previousTransport: AgentTransportStatus | undefined,
		previousFingerprint: string,
		postSubmit: boolean,
		relayAnchor: boolean,
		output: string | undefined,
	): Promise<void> {
		const outputFingerprint = output === undefined ? previousFingerprint : hashDebugText(output) ?? "";
		if (!this.dependencies.onObservation || (previousTransport === snapshot.status && previousFingerprint === outputFingerprint)) return;
		await this.dependencies.onObservation({
			transportStatus: snapshot.status,
			readAttempt,
			outputFingerprint,
			outputLength: output?.length,
			postSubmit,
			relayAnchor,
			agentSession: snapshot.agentSession!,
			paneId: snapshot.paneId,
		});
	}

	/** Builds a result after a parseable completion contract. */
	private resultFromCompletion(input: AgentTurnObservationInput, resultKey: string, snapshot: HerdrAgentSnapshot, observations: number, completion: CompletionContract, source: "terminal" | "pi-session"): AgentTurnObservationResult {
		const status = snapshot.status === "blocked" && completion.status === "ERROR" ? "BLOCKED" : completion.status;
		return {
			status,
			transportStatus: snapshot.status,
			completion: status === "BLOCKED" && completion.status === "ERROR" ? { ...completion, status: "BLOCKED" } : completion,
			agentSession: snapshot.agentSession!,
			paneId: snapshot.paneId,
			agent: snapshot.agent,
			relayMessageId: input.relayMessageId,
			attempt: input.attempt,
			fencingToken: input.fencingToken,
			resultKey,
			observations,
			captureSource: source,
			executionFence: input.executionFence,
			error: completion.status === "DONE" ? undefined : completion.summary,
		};
	}

	/** Builds a fail-closed identity result without creating or replacing a child. */
	private blockedResult(input: AgentTurnObservationInput, resultKey: string, snapshot: HerdrAgentSnapshot | undefined, observations: number, error: string): AgentTurnObservationResult {
		return {
			status: "BLOCKED",
			transportStatus: snapshot?.status ?? "unknown",
			agentSession: input.expectedSession,
			paneId: input.paneId,
			agent: input.target,
			relayMessageId: input.relayMessageId,
			attempt: input.attempt,
			fencingToken: input.fencingToken,
			executionFence: input.executionFence,
			resultKey,
			observations,
			error,
		};
	}

	/** Builds a bounded incomplete result while preserving exact identity metadata. */
	private partialResult(input: AgentTurnObservationInput, resultKey: string, snapshot: HerdrAgentSnapshot | undefined, observations: number, error: unknown): AgentTurnObservationResult {
		return {
			status: "PARTIAL",
			transportStatus: snapshot?.status ?? "unknown",
			agentSession: snapshot?.agentSession ?? input.expectedSession,
			paneId: snapshot?.paneId ?? input.paneId,
			agent: snapshot?.agent ?? input.target,
			relayMessageId: input.relayMessageId,
			attempt: input.attempt,
			fencingToken: input.fencingToken,
			executionFence: input.executionFence,
			resultKey,
			observations,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
