import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { buildRelayEnvelope, DelegateEngine } from "./engine.ts";
import { HerdrCommandError } from "./herdr/client.ts";
import { parseDelegateConfig } from "./config.ts";
import { readEventLog } from "./records.ts";
import type {
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
	CreateTabInput,
} from "./types.ts";

/** Optional lifecycle overrides used to exercise exact-session recovery failures. */
interface FakeGatewayOptions {
	/** Agent target that should be reported as definitively closed. */
	closedTarget?: string;
	/** Exact session returned consistently by the simulated child lifecycle. */
	session?: SessionIdentity;
	/** Session identity returned by resumed agent startup. */
	startedSession?: SessionIdentity;
	/** Session identity returned only by post-start getAgent calls. */
	lookupSession?: SessionIdentity;
	/** Terminal snapshots returned sequentially to simulate Herdr's delayed TUI refresh. */
	outputs?: readonly string[];
	/** Error thrown by the simulated relay command. */
	promptError?: Error;
}

/** Deterministic fake gateway for leaf engine tests. */
class FakeGateway implements HerdrGateway {
	readonly calls: string[] = [];
	lastPrompt?: PromptInput;
	lastMove?: MovePaneInput;
	private readonly childSnapshot: HerdrAgentSnapshot;
	private readonly output: string;
	private readonly outputs?: readonly string[];
	private outputIndex = 0;
	private readonly closedTarget?: string;
	private readonly startedSession?: SessionIdentity;
	private readonly lookupSession?: SessionIdentity;
	private readonly promptError?: Error;
	private relaySubmitted = false;

	/**
	 * Creates a fake child lifecycle.
	 *
	 * @param output Completion-contract text returned by readAgent.
	 * @param status Settled transport state returned by waitFor.
	 * @param sessionExact Whether exact agent session metadata is returned.
	 * @param options Optional closed-target and resumed-session behavior.
	 */
	constructor(output: string, status: HerdrAgentSnapshot["status"] = "idle", sessionExact = true, options: FakeGatewayOptions = {}) {
		this.output = output;
		this.outputs = options.outputs;
		this.closedTarget = options.closedTarget;
		this.startedSession = options.startedSession;
		this.lookupSession = options.lookupSession;
		this.promptError = options.promptError;
		this.childSnapshot = {
			agent: "worker-test",
			status,
			paneId: "w-test:p2",
			workspaceId: "w-test",
			tabId: "w-test:t1",
			cwd: "/tmp/project",
			agentSession: sessionExact ? options.session ?? { kind: "id", source: "fake", value: "session-test" } : undefined,
		};
	}

	async splitPane(_input: SplitPaneInput): Promise<HerdrPane> { this.calls.push("split"); return { paneId: "w-test:p2", workspaceId: "w-test", tabId: "w-test:t1" }; }
	async startAgent(_input: StartAgentInput): Promise<HerdrAgentSnapshot> {
		this.calls.push("start");
		// A resumed pane may report a different session; the engine must reject it.
		return this.startedSession ? { ...this.childSnapshot, agentSession: this.startedSession } : this.childSnapshot;
	}
	async prompt(input: PromptInput): Promise<HerdrAgentSnapshot | undefined> {
		this.calls.push("prompt");
		this.lastPrompt = input;
		this.relaySubmitted = true;
		if (this.promptError) throw this.promptError;
		return this.childSnapshot;
	}
	async waitFor(_input: WaitInput): Promise<HerdrAgentSnapshot> { this.calls.push("wait"); return this.childSnapshot; }
	async getAgent(target: string): Promise<HerdrAgentSnapshot> {
		this.calls.push("get");
		if (target === this.closedTarget) {
			// 404 is the gateway's definitive closed-pane signal.
			throw Object.assign(new Error("agent not found"), { code: 404 });
		}
		return this.lookupSession ? { ...this.childSnapshot, agentSession: this.lookupSession } : this.childSnapshot;
	}
	async readAgent(_target: string): Promise<HerdrAgentOutput> {
		this.calls.push("read");
		if (!this.relaySubmitted) return { text: "" };
		const output = this.outputs?.[Math.min(this.outputIndex++, this.outputs.length - 1)] ?? this.output;
		return { text: output };
	}
	async createTab(_input: CreateTabInput): Promise<{ tabId: string; paneId?: string }> { this.calls.push("tab-create"); return { tabId: "w-test:t2" }; }
	async movePane(input: MovePaneInput): Promise<{ tabId?: string }> { this.calls.push("move"); this.lastMove = input; return { tabId: "w-test:t2" }; }
	async closePane(_paneId: string): Promise<void> { this.calls.push("close"); }
	async snapshot(): Promise<HerdrSnapshot> { this.calls.push("snapshot"); return { raw: {}, agents: [this.childSnapshot] }; }
}

/** Builds one minimally complete Pi session message for exact-session output-capture tests. */
function piSessionMessage(role: "assistant" | "user", text: string): string {
	return JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
}

/** Creates a deterministic engine with an isolated JSONL communication directory. */
async function createEngine(gateway: HerdrGateway, root: string): Promise<DelegateEngine> {
	return new DelegateEngine({
		gateway,
		config: parseDelegateConfig({ version: 1 }),
		communicationDirectory: join(root, "communications"),
		id: (() => {
			let count = 0;
			return () => `id-${++count}`;
		})(),
	});
}

/** Checks DONE requires exact session, result event, and new-tab disposition order. */
test("DelegateEngine completes a leaf only after exact checkpoint and DONE contract", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-done-"));
	try {
		const gateway = new FakeGateway("STATUS: DONE\nSUMMARY: implemented\nVALIDATION: tests passed\nCHANGED FILES: none");
		const engine = await createEngine(gateway, root);
		const result = await engine.run({ action: "delegate", task: "implement", role: "worker" }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "DONE");
		assert.equal(gateway.lastPrompt?.wait, false);
		assert.ok((gateway.lastPrompt?.timeoutMs ?? 0) >= 300000);
		assert.deepEqual(gateway.calls, ["split", "start", "get", "read", "prompt", "wait", "read", "move"]);
		assert.equal(gateway.lastMove?.paneId, "w-test:p2");
		assert.equal(gateway.lastMove?.newTab, true);
		assert.equal(gateway.lastMove?.tabLabel, `closed-pane-${result.communicationId}`);
		assert.equal(gateway.lastMove?.workspaceId, "w-test");
		assert.equal(gateway.lastMove?.focus, false);
		assert.ok(result.communicationFile.endsWith(".jsonl"));
		const events = (await readEventLog(result.communicationFile)).events;
		assert.equal(events.at(-1)?.event.type, "pane-disposition");
		assert.equal(events.find(({ event }) => event.type === "result")?.event.payload.status, "DONE");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});


/** Verifies an unknown relay submission continues through the same exact-session monitor. */
test("DelegateEngine observes a child after an ambiguous Herdr relay failure", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-command-timeout-"));
	try {
		const timeout = new HerdrCommandError("The operation was aborted", ["agent", "prompt"], null, null, "", "", true);
		const gateway = new FakeGateway("STATUS: DONE\nSUMMARY: late completion\nVALIDATION: late validation", "working", true, { promptError: timeout });
		const engine = await createEngine(gateway, root);
		const result = await engine.run({ action: "delegate", task: "run a slow build", role: "worker", deadlineAt: new Date(Date.now() + 1000).toISOString() }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "DONE");
		assert.equal(result.completion?.summary, "late completion");
		assert.deepEqual(gateway.calls, ["split", "start", "get", "read", "prompt", "wait", "read", "move"]);
		const events = (await readEventLog(result.communicationFile)).events.map(({ event }) => event);
		const promptCheckpoint = events.find((event) => event.type === "checkpoint" && event.payload.operation === "relay-submitted");
		assert.equal(promptCheckpoint?.payload.accepted, "unknown");
		assert.equal(events.at(-1)?.type, "pane-disposition");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Verifies only explicit pre-delivery evidence permits one same-relay retry. */
test("DelegateEngine retries an explicitly unsent relay once", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-relay-retry-"));
	try {
		const notSent = Object.assign(new Error("spawn failed before delivery"), { deliveryState: "NOT_SENT" as const });
		const gateway = new FakeGateway("STATUS: DONE\nSUMMARY: retry completed\nVALIDATION: retry validation", "working", true, { promptError: notSent });
		const engine = await createEngine(gateway, root);
		const result = await engine.run({ action: "delegate", task: "retry a relay", role: "worker", deadlineAt: new Date(Date.now() + 1_000).toISOString() }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "DONE");
		assert.equal(gateway.calls.filter((call) => call === "prompt").length, 2);
		const events = (await readEventLog(result.communicationFile)).events.map(({ event }) => event);
		assert.equal(events.some((event) => event.type === "relay-retry"), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Reconciles only a late completion tied to the original exact Pi relay without sending another prompt. */
test("DelegateEngine reconciles a late exact Pi completion without resending", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-reconcile-"));
	try {
		const sessionFile = join(root, "child-session.jsonl");
		const session = { kind: "path" as const, source: "herdr:pi", value: sessionFile };
		const timeout = new HerdrCommandError("The operation was aborted", ["agent", "prompt"], null, null, "", "", true);
		const gateway = new FakeGateway("", "idle", true, { session, promptError: timeout });
		const engine = await createEngine(gateway, root);
		const partial = await engine.run({ action: "delegate", task: "run a slow build", role: "worker", deadlineAt: new Date(Date.now() + 3_000).toISOString() }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(partial.status, "PARTIAL");
		const handoff = (await readEventLog(partial.communicationFile)).events.find(({ event }) => event.type === "task");
		assert.ok(handoff?.event.messageId);
		const relay = buildRelayEnvelope(partial.communicationFile, handoff.line, handoff.line, 1, handoff.event.messageId);
		await writeFile(sessionFile, [
			piSessionMessage("user", relay),
			piSessionMessage("assistant", "STATUS: DONE\nSUMMARY: completed after the parent wait ended\nVALIDATION: build passed"),
		].join("\n"));
		const reconciled = await engine.reconcilePartial(partial, {
			workspaceId: "w-test",
		});
		assert.equal(reconciled?.status, "DONE");
		assert.equal(reconciled?.completion?.summary, "completed after the parent wait ended");
		assert.equal(gateway.calls.filter((call) => call === "prompt").length, 1);
		assert.equal(gateway.calls.includes("move"), true);
		const events = (await readEventLog(partial.communicationFile)).events.map(({ event }) => event);
		const reconciledResult = events.find((event) => event.type === "reconciliation-result" && event.payload.operation === "reconcile");
		assert.equal(reconciledResult?.payload.status, "DONE");
		assert.equal(reconciledResult?.payload.reconciliation, true);
		assert.equal(events.at(-1)?.type, "pane-disposition");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Refuses a late completion when Herdr now reports a different exact child session. */
test("DelegateEngine leaves a partial result unchanged when reconciliation session continuity fails", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-reconcile-mismatch-"));
	try {
		const sessionFile = join(root, "expected-child-session.jsonl");
		const session = { kind: "path" as const, source: "herdr:pi", value: sessionFile };
		const timeout = new HerdrCommandError("The operation was aborted", ["agent", "prompt"], null, null, "", "", true);
		const gateway = new FakeGateway("", "idle", true, {
			session,
			lookupSession: { kind: "path", source: "herdr:pi", value: join(root, "replacement-session.jsonl") },
			promptError: timeout,
		});
		const engine = await createEngine(gateway, root);
		const partial = await engine.run({ action: "delegate", task: "run a slow build", role: "worker", deadlineAt: new Date(Date.now() + 3_000).toISOString() }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		const reconciled = await engine.reconcilePartial(partial, { workspaceId: "w-test" });
		assert.equal(reconciled, undefined);
		assert.equal(gateway.calls.filter((call) => call === "prompt").length, 0);
		assert.equal(gateway.calls.includes("get"), true);
		const events = (await readEventLog(partial.communicationFile)).events.map(({ event }) => event);
		assert.equal(events.some((event) => event.type === "result" && event.payload.operation === "reconcile"), false);
		assert.equal(gateway.calls.includes("move"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Verifies a user-cancelled child is incomplete work, not a semantic task ERROR. */
test("DelegateEngine classifies a manually interrupted child as PARTIAL and preserves the pane", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-interrupted-"));
	try {
		const gateway = new FakeGateway("Conversation interrupted\n› Write tests for @filename", "idle");
		const engine = new DelegateEngine({
			gateway,
			config: parseDelegateConfig({ version: 1 }),
			communicationDirectory: join(root, "communications"),
			id: () => "interrupted-child",
			sleep: async () => {},
		});
		const result = await engine.run({ action: "delegate", task: "write tests", role: "worker" }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "PARTIAL");
		assert.match(result.error ?? "", /interrupted/i);
		assert.equal(gateway.calls.includes("move"), false);
		assert.equal(gateway.calls.includes("close"), false);
		const events = (await readEventLog(result.communicationFile)).events.map(({ event }) => event);
		const resultEvent = events.find((event) => event.type === "result");
		assert.equal(resultEvent?.payload.status, "PARTIAL");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Verifies every external child receives the literal semantic completion vocabulary. */
test("buildRelayEnvelope states the exact completion contract", () => {
	const relay = buildRelayEnvelope("/tmp/task.jsonl", 2, 2, 1, "msg-contract");
	assert.match(relay, /STATUS: DONE\|BLOCKED\|PARTIAL\|ERROR/);
	assert.match(relay, /SUMMARY: <one-line result>/);
	assert.match(relay, /VALIDATION: <commands or checks performed>/);
	assert.match(relay, /Use STATUS: DONE only when the task is complete and validated\./);
});

/** Verifies delayed Herdr terminal refreshes are reread without creating or prompting a new child. */
test("DelegateEngine rereads a stale terminal snapshot before parsing the completion contract", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-output-refresh-"));
	try {
		const gateway = new FakeGateway("STATUS: DONE\nSUMMARY: unused\nVALIDATION: unused", "done", true, {
			outputs: ["child terminal has not refreshed", "STATUS: DONE\nSUMMARY: refreshed\nVALIDATION: captured"],
		});
		const delays: number[] = [];
		const engine = new DelegateEngine({
			gateway,
			config: parseDelegateConfig({ version: 1 }),
			communicationDirectory: join(root, "communications"),
			id: () => "output-refresh",
			sleep: async (milliseconds) => { delays.push(milliseconds); },
		});
		const result = await engine.run({ action: "delegate", task: "capture output", role: "worker" }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "DONE");
		assert.equal(gateway.calls.filter((call) => call === "read").length, 3);
		assert.deepEqual(delays, [250]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Covers narrow-pane terminal refreshes that expose the contract only after the original retry budget. */
test("DelegateEngine keeps rereading a slow terminal refresh within the bounded budget", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-slow-output-refresh-"));
	try {
		const gateway = new FakeGateway("STATUS: DONE\nSUMMARY: unused\nVALIDATION: unused", "done", true, {
			outputs: [
				"terminal output is still fragmented",
				"terminal output is still fragmented",
				"terminal output is still fragmented",
				"terminal output is still fragmented",
				"terminal output is still fragmented",
				"STATUS: DONE\nSUMMARY: delayed refresh\nVALIDATION: captured after rereads",
			],
		});
		const delays: number[] = [];
		const engine = new DelegateEngine({
			gateway,
			config: parseDelegateConfig({ version: 1 }),
			communicationDirectory: join(root, "communications"),
			id: () => "slow-output-refresh",
			sleep: async (milliseconds) => { delays.push(milliseconds); },
		});
		const result = await engine.run({ action: "delegate", task: "capture slow output", role: "worker" }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "DONE");
		assert.equal(result.completion?.summary, "delayed refresh");
		assert.equal(gateway.calls.filter((call) => call === "read").length, 7);
		assert.deepEqual(delays, [250, 250, 250, 250, 250]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Ensures a delayed non-Pi terminal refresh survives the original five-second capture budget. */
test("DelegateEngine captures a contract that appears after twenty terminal rereads", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-late-output-refresh-"));
	try {
		const gateway = new FakeGateway("STATUS: DONE\nSUMMARY: unused\nVALIDATION: unused", "done", true, {
			outputs: [
				...Array.from({ length: 20 }, () => "terminal output is still stale"),
				"STATUS: DONE\nSUMMARY: late non-Pi refresh\nVALIDATION: captured after the extended budget",
			],
		});
		const delays: number[] = [];
		const engine = new DelegateEngine({
			gateway,
			config: parseDelegateConfig({ version: 1 }),
			communicationDirectory: join(root, "communications"),
			id: () => "late-output-refresh",
			sleep: async (milliseconds) => { delays.push(milliseconds); },
		});
		const result = await engine.run({ action: "delegate", task: "capture late output", role: "worker" }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "DONE");
		assert.equal(result.completion?.summary, "late non-Pi refresh");
		assert.equal(gateway.calls.filter((call) => call === "read").length, 22);
		assert.equal(delays.length, 20);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("DelegateEngine falls back to the exact Pi session when Herdr terminal rows wrap", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-session-fallback-"));
	try {
		const sessionFile = join(root, "child.jsonl");
		const communicationFile = join(root, "communications", "worker-session-fallback.jsonl");
		const currentRelay = [
			`COMMUNICATION FILE: ${communicationFile}`,
			"MESSAGE ID: msg-session-fallback",
		].join("\n");
		await writeFile(sessionFile, [
			piSessionMessage("user", "COMMUNICATION FILE: /tmp/old.jsonl\nMESSAGE ID: msg-old"),
			piSessionMessage("assistant", "STATUS: DONE\nSUMMARY: stale result\nVALIDATION: stale validation"),
			piSessionMessage("user", currentRelay),
			piSessionMessage("assistant", "STATUS: DONE\nSUMMARY: session fallback completed\nVALIDATION: exact Pi session read"),
		].join("\n").concat("\n"));
		const session: SessionIdentity = { kind: "path", source: "herdr:pi", value: sessionFile };
		const gateway = new FakeGateway("S\nT\nA\nT\nU\nS\n:\nD\nO\nN\nE", "done", true, { session });
		const engine = new DelegateEngine({
			gateway,
			config: parseDelegateConfig({ version: 1 }),
			communicationDirectory: join(root, "communications"),
			id: () => "session-fallback",
			sleep: async () => { throw new Error("wrapped terminal capture should use the exact session before retrying"); },
		});
		const result = await engine.run({ action: "delegate", task: "capture wrapped output", role: "worker" }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "DONE");
		assert.equal(result.completion?.summary, "session fallback completed");
		assert.equal(gateway.calls.filter((call) => call === "read").length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("DelegateEngine preserves a blocked child pane", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-blocked-"));
	try {
		const gateway = new FakeGateway("not a completion contract", "blocked");
		const engine = await createEngine(gateway, root);
		const result = await engine.run({ action: "delegate", task: "implement", role: "worker" }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "BLOCKED");
		assert.equal(gateway.calls.includes("tab-create"), false);
		assert.equal(gateway.calls.includes("close"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Checks missing exact session metadata blocks before reading child output as DONE. */
test("DelegateEngine blocks when startup lacks exact session metadata", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-session-"));
	try {
		const gateway = new FakeGateway("STATUS: DONE\nSUMMARY: implemented\nVALIDATION: tests passed", "idle", false);
		const engine = await createEngine(gateway, root);
		const result = await engine.run({ action: "delegate", task: "implement", role: "worker" }, {
			cwd: "/tmp/project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});
		assert.equal(result.status, "BLOCKED");
		assert.equal(gateway.calls.includes("wait"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Checks exact-session resume blocks when the replacement pane reports another session. */
test("DelegateEngine blocks an exact resume that returns a different session", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-engine-resume-mismatch-"));
	try {
		const initialGateway = new FakeGateway("STATUS: BLOCKED\nSUMMARY: waiting\nVALIDATION: pending", "blocked");
		const initialEngine = await createEngine(initialGateway, root);
		const initial = await initialEngine.run({
			action: "delegate",
			task: "start stage",
			role: "worker",
			overrides: { panePolicy: "keep" },
		}, { cwd: "/tmp/project", workspaceId: "w-test", sourcePaneId: "w-test:p1" });
		assert.equal(initial.status, "BLOCKED");
		assert.ok(initial.agent);
		assert.ok(initial.agentSession);
		assert.ok(initial.paneId);

		const log = await readEventLog(initial.communicationFile);
		const created = log.events[0]?.event;
		assert.ok(created);
		const replacementSession: SessionIdentity = { kind: "id", source: "fake", value: "different-session" };
		const resumeGateway = new FakeGateway(
			"STATUS: DONE\nSUMMARY: should not be accepted\nVALIDATION: not reached",
			"idle",
			true,
			{ closedTarget: initial.agent, startedSession: replacementSession },
		);
		const resumeEngine = await createEngine(resumeGateway, root);
		const resumed = await resumeEngine.run({
			action: "delegate",
			task: "continue stage",
			role: "worker",
			transaction: created.transaction,
			stageOccurrence: created.stageOccurrence,
			previousCommunication: initial.communicationFile,
			previousPaneId: initial.paneId,
			previousAgent: initial.agent,
			previousSession: initial.agentSession,
			continuation: "continue only if exact identity is preserved",
			overrides: { panePolicy: "keep" },
		}, { cwd: "/tmp/project", workspaceId: "w-test", sourcePaneId: "w-test:p1" });

		assert.equal(resumed.status, "BLOCKED");
		assert.deepEqual(resumed.agentSession, initial.agentSession);
		assert.match(resumed.error ?? "", /different agent_session/);
		const resumedEvents = (await readEventLog(resumed.communicationFile)).events;
		const mismatchCheckpoint = resumedEvents.at(-1)?.event;
		assert.deepEqual(mismatchCheckpoint?.agentSession, initial.agentSession);
		assert.deepEqual(mismatchCheckpoint?.payload.expectedAgentSession, initial.agentSession);
		assert.deepEqual(mismatchCheckpoint?.payload.observedAgentSession, replacementSession);
		assert.equal(resumeGateway.calls.includes("wait"), false);
		assert.equal(resumeGateway.calls.includes("tab-create"), false);
		assert.equal(resumeGateway.calls.includes("move"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

