import assert from "node:assert/strict";
import test from "node:test";

import { AgentTurnMonitor, buildResultKey, type AgentTurnObservationInput } from "./agent-monitor.ts";
import { hashDebugText } from "./debug.ts";
import type {
	CreateTabInput,
	HerdrAgentOutput,
	HerdrAgentSnapshot,
	HerdrGateway,
	HerdrPane,
	HerdrSnapshot,
	MovePaneInput,
	PromptInput,
	SessionIdentity,
	SplitPaneInput,
	StartAgentInput,
	WaitInput,
} from "./types.ts";

/** Minimal gateway used to drive deterministic monitor transport and output transitions. */
class MonitorFakeGateway implements HerdrGateway {
	/** Number of wait calls issued by the monitor. */
	waitCalls = 0;
	/** Number of terminal reads issued by the monitor. */
	readCalls = 0;
	/** Optional closure failure returned from wait. */
	closedError?: Error & { code?: number };
	/** Optional transient wait failure used to exercise getAgent fallback. */
	waitError?: Error & { timedOut?: boolean };
	/** Number of exact metadata lookups issued by the monitor. */
	getCalls = 0;
	/** Exact output snapshots returned in order. */
	private readonly outputs: readonly string[];
	/** Exact child identity used by every successful observation. */
	private readonly child: HerdrAgentSnapshot;

	/**
	 * Creates a monitor gateway fake.
	 *
	 * @param outputs Ordered terminal snapshots.
	 * @param status Transport status returned by wait.
	 */
	constructor(outputs: readonly string[], status: HerdrAgentSnapshot["status"] = "idle") {
		this.outputs = outputs;
		this.child = {
			agent: "worker-monitor",
			status,
			paneId: "w-monitor:p2",
			workspaceId: "w-monitor",
			agentSession: { kind: "id", source: "fake", value: "monitor-session" },
		};
	}

	/** Splits are outside the observation seam and are not used by these tests. */
	async splitPane(_input: SplitPaneInput): Promise<HerdrPane> { return { paneId: this.child.paneId, workspaceId: this.child.workspaceId }; }
	/** Agent startup is outside the observation seam and returns the exact child. */
	async startAgent(_input: StartAgentInput): Promise<HerdrAgentSnapshot> { return this.child; }
	/** Relay submission is outside the observation seam and is never sent by the monitor. */
	async prompt(_input: PromptInput): Promise<HerdrAgentSnapshot | undefined> { return this.child; }
	/** Returns the configured transport hint for one polling attempt. */
	async waitFor(_input: WaitInput): Promise<HerdrAgentSnapshot> {
		this.waitCalls += 1;
		if (this.closedError) throw this.closedError;
		if (this.waitError) {
			const error = this.waitError;
			this.waitError = undefined;
			throw error;
		}
		return this.child;
	}
	/** Returns exact identity metadata for fallback callers. */
	async getAgent(_target: string): Promise<HerdrAgentSnapshot> { this.getCalls += 1; return this.child; }
	/** Returns one terminal snapshot without exposing any test output to diagnostics. */
	async readAgent(_target: string): Promise<HerdrAgentOutput> {
		const index = Math.min(this.readCalls, Math.max(0, this.outputs.length - 1));
		this.readCalls += 1;
		return { text: this.outputs[index] ?? "" };
	}
	/** Tab operations are outside the observation seam. */
	async createTab(_input: CreateTabInput): Promise<{ tabId: string }> { return { tabId: "w-monitor:t2" }; }
	/** Pane disposition is outside the observation seam. */
	async movePane(_input: MovePaneInput): Promise<{ tabId?: string }> { return { tabId: "w-monitor:t2" }; }
	/** Pane closure is outside the observation seam. */
	async closePane(_paneId: string): Promise<void> { return undefined; }
	/** Snapshot probing is outside the observation seam. */
	async snapshot(): Promise<HerdrSnapshot> { return { raw: {}, agents: [this.child] }; }
}

/** Creates the exact identity input shared by monitor tests. */
function monitorInput(overrides: Partial<AgentTurnObservationInput> = {}): AgentTurnObservationInput {
	const expectedSession: SessionIdentity = { kind: "id", source: "fake", value: "monitor-session" };
	return {
		target: "worker-monitor",
		paneId: "w-monitor:p2",
		workspaceId: "w-monitor",
		transactionId: "tx-monitor",
		stageId: "stage-monitor",
		stageOccurrence: 1,
		attempt: 1,
		executionFence: "fence-monitor",
		expectedSession,
		communicationFile: "/tmp/monitor.jsonl",
		relayMessageId: "msg-monitor",
		baseline: { fingerprint: hashDebugText("old output") ?? "", length: 10, capturedAt: new Date(0).toISOString(), source: "terminal" },
		submittedAt: new Date(0).toISOString(),
		owner: "parent",
		deadlineAt: new Date(Date.now() + 1_000).toISOString(),
		...overrides,
	};
}

/** Verifies idle transport remains a hint until post-relay output produces a current contract. */
test("AgentTurnMonitor waits past idle until a post-relay DONE contract", async () => {
	const gateway = new MonitorFakeGateway([
		"old output",
		"STATUS: DONE\nSUMMARY: monitor completed\nVALIDATION: monitor test passed",
	]);
	const observations: string[] = [];
	const result = await new AgentTurnMonitor({
		gateway,
		sleep: async () => undefined,
		onObservation: (observation) => { observations.push(`${observation.readAttempt}:${observation.outputFingerprint}`); },
	}).observe(monitorInput());

	assert.equal(result.status, "DONE");
	assert.equal(result.captureSource, "terminal");
	assert.equal(result.completion?.summary, "monitor completed");
	assert.equal(gateway.waitCalls, 2);
	assert.equal(gateway.readCalls, 2);
	assert.equal(observations.length, 2);
	assert.equal(result.resultKey, buildResultKey(monitorInput()));
});

/** Verifies exact identity loss is BLOCKED before the monitor can accept output. */
test("AgentTurnMonitor blocks a changed pane or session", async () => {
	const gateway = new MonitorFakeGateway(["STATUS: DONE\nSUMMARY: stale\nVALIDATION: stale"]);
	const result = await new AgentTurnMonitor({ gateway, sleep: async () => undefined }).observe(monitorInput({ paneId: "w-other:p2" }));

	assert.equal(result.status, "BLOCKED");
	assert.match(result.error ?? "", /identity changed/);
	assert.equal(gateway.readCalls, 0);
	const sessionGateway = new MonitorFakeGateway(["STATUS: DONE\nSUMMARY: wrong\nVALIDATION: wrong"]);
	const sessionResult = await new AgentTurnMonitor({ gateway: sessionGateway, sleep: async () => undefined }).observe(monitorInput({ expectedSession: { kind: "id", source: "fake", value: "different-session" } }));
	assert.equal(sessionResult.status, "BLOCKED");
	assert.equal(sessionGateway.readCalls, 0);
});

/** Verifies a definitive closed-agent response maps to BLOCKED without a replacement session. */
test("AgentTurnMonitor maps definitive closure to BLOCKED", async () => {
	const gateway = new MonitorFakeGateway([]);
	gateway.closedError = Object.assign(new Error("agent_not_found"), { code: 404 });
	const result = await new AgentTurnMonitor({ gateway, sleep: async () => undefined }).observe(monitorInput());

	assert.equal(result.status, "BLOCKED");
	assert.equal(result.transportStatus, "unknown");
	assert.match(result.error ?? "", /closed the exact agent/);
	assert.equal(gateway.readCalls, 0);
});

/** Verifies missing contracts become bounded PARTIAL rather than semantic ERROR. */
test("AgentTurnMonitor returns PARTIAL after the bounded observation budget", async () => {
	const gateway = new MonitorFakeGateway(["old output", "still no contract"]);
	const result = await new AgentTurnMonitor({ gateway, maxAttempts: 2, sleep: async () => undefined }).observe(monitorInput());

	assert.equal(result.status, "PARTIAL");
	assert.equal(result.completion, undefined);
	assert.equal(result.observations, 2);
	assert.match(result.error ?? "", /contract/);
});

/** Verifies a bounded Herdr wait timeout is only a poll hint and does not terminate the stage. */
test("AgentTurnMonitor continues after a bounded wait timeout", async () => {
	const gateway = new MonitorFakeGateway(["old output", "STATUS: DONE\nSUMMARY: after wait timeout\nVALIDATION: fallback lookup"]);
	gateway.waitError = Object.assign(new Error("poll timeout"), { timedOut: true });
	const result = await new AgentTurnMonitor({ gateway, sleep: async () => undefined }).observe(monitorInput());

	assert.equal(result.status, "DONE");
	assert.equal(gateway.getCalls, 0);
	assert.equal(gateway.waitCalls, 3);
});

/** Verifies a non-timeout wait failure falls back to exact getAgent metadata before reading output. */
test("AgentTurnMonitor falls back to exact metadata after a wait error", async () => {
	const gateway = new MonitorFakeGateway(["old output", "STATUS: DONE\nSUMMARY: after get fallback\nVALIDATION: fallback lookup"]);
	gateway.waitError = new Error("temporary wait transport failure");
	const result = await new AgentTurnMonitor({ gateway, sleep: async () => undefined }).observe(monitorInput());

	assert.equal(result.status, "DONE");
	assert.equal(gateway.getCalls, 1);
});

/** Rejects a stale completion that carries only an older relay marker from the same communication file. */
test("AgentTurnMonitor rejects a foreign relay marker despite changed output", async () => {
	const gateway = new MonitorFakeGateway([
		`COMMUNICATION FILE: /tmp/monitor.jsonl\nMESSAGE ID: old-relay\nSTATUS: DONE\nSUMMARY: stale\nVALIDATION: stale`,
	]);
	const result = await new AgentTurnMonitor({ gateway, maxAttempts: 1, sleep: async () => undefined }).observe(monitorInput());

	assert.equal(result.status, "PARTIAL");
	assert.equal(result.completion, undefined);
});

/** Verifies continuations tolerate terminal line wrapping without accepting a foreign relay. */
// TEST:agent-monitor.test.ts[AgentTurnMonitor accepts terminal-wrapped current relay markers]
test("AgentTurnMonitor accepts terminal-wrapped current relay markers", async () => {
	const input = monitorInput({ requireRelayAnchor: true });
	const wrappedCommunicationFile = input.communicationFile.replace("/tmp/", "/\n  tmp/");
	const gateway = new MonitorFakeGateway([
		`MESSAGE ID: ${input.relayMessageId}\nCOMMUNICATION FILE: ${wrappedCommunicationFile}\nSTATUS: DONE\nSUMMARY: wrapped continuation\nVALIDATION: marker matching`,
	]);
	const result = await new AgentTurnMonitor({ gateway, maxAttempts: 1, sleep: async () => undefined }).observe(input);

	assert.equal(result.status, "DONE");
	assert.equal(result.completion?.summary, "wrapped continuation");
});

/** Verifies a continuation cannot accept changed unanchored terminal output. */
test("AgentTurnMonitor requires the current relay anchor for continuations", async () => {
	const gateway = new MonitorFakeGateway(["STATUS: DONE\nSUMMARY: stale continuation\nVALIDATION: stale"]);
	const result = await new AgentTurnMonitor({ gateway, maxAttempts: 1, sleep: async () => undefined }).observe(monitorInput({ requireRelayAnchor: true }));

	assert.equal(result.status, "PARTIAL");
	assert.equal(result.completion, undefined);
});

/** Verifies an exact Pi fallback can produce a current relay result without terminal headings. */
test("AgentTurnMonitor accepts an anchored exact-session fallback", async () => {
	const gateway = new MonitorFakeGateway(["fragmented terminal output"]);
	const result = await new AgentTurnMonitor({
		gateway,
		sleep: async () => undefined,
		captureFallback: async () => ({
			completion: { status: "DONE", summary: "Pi fallback completed", validation: "exact session read" },
			source: "pi-session",
			attempts: 1,
		}),
	}).observe(monitorInput());

	assert.equal(result.status, "DONE");
	assert.equal(result.captureSource, "pi-session");
	assert.equal(result.completion?.summary, "Pi fallback completed");
});
