import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { DelegateEngine } from "./engine.ts";
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
	/** Session identity returned by resumed agent startup. */
	startedSession?: SessionIdentity;
}

/** Deterministic fake gateway for leaf engine tests. */
class FakeGateway implements HerdrGateway {
	readonly calls: string[] = [];
	private readonly childSnapshot: HerdrAgentSnapshot;
	private readonly output: string;
	private readonly closedTarget?: string;
	private readonly startedSession?: SessionIdentity;

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
		this.closedTarget = options.closedTarget;
		this.startedSession = options.startedSession;
		this.childSnapshot = {
			agent: "worker-test",
			status,
			paneId: "w-test:p2",
			workspaceId: "w-test",
			tabId: "w-test:t1",
			cwd: "/tmp/project",
			agentSession: sessionExact ? { kind: "id", source: "fake", value: "session-test" } : undefined,
		};
	}

	async splitPane(_input: SplitPaneInput): Promise<HerdrPane> { this.calls.push("split"); return { paneId: "w-test:p2", workspaceId: "w-test", tabId: "w-test:t1" }; }
	async startAgent(_input: StartAgentInput): Promise<HerdrAgentSnapshot> {
		this.calls.push("start");
		// A resumed pane may report a different session; the engine must reject it.
		return this.startedSession ? { ...this.childSnapshot, agentSession: this.startedSession } : this.childSnapshot;
	}
	async prompt(_input: PromptInput): Promise<HerdrAgentSnapshot | undefined> { this.calls.push("prompt"); return this.childSnapshot; }
	async waitFor(_input: WaitInput): Promise<HerdrAgentSnapshot> { this.calls.push("wait"); return this.childSnapshot; }
	async getAgent(target: string): Promise<HerdrAgentSnapshot> {
		this.calls.push("get");
		if (target === this.closedTarget) {
			// 404 is the gateway's definitive closed-pane signal.
			throw Object.assign(new Error("agent not found"), { code: 404 });
		}
		return this.childSnapshot;
	}
	async readAgent(_target: string): Promise<HerdrAgentOutput> { this.calls.push("read"); return { text: this.output }; }
	async createTab(_input: CreateTabInput): Promise<{ tabId: string; paneId?: string }> { this.calls.push("tab-create"); return { tabId: "w-test:t2" }; }
	async movePane(_input: MovePaneInput): Promise<{ tabId?: string }> { this.calls.push("move"); return { tabId: "w-test:t2" }; }
	async closePane(_paneId: string): Promise<void> { this.calls.push("close"); }
	async snapshot(): Promise<HerdrSnapshot> { this.calls.push("snapshot"); return { raw: {}, agents: [this.childSnapshot] }; }
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
		assert.deepEqual(gateway.calls, ["split", "start", "prompt", "wait", "read", "tab-create", "move"]);
		assert.ok(result.communicationFile.endsWith(".jsonl"));
		const events = (await readEventLog(result.communicationFile)).events;
		assert.equal(events.at(-1)?.event.type, "pane-disposition");
		assert.equal(events.find(({ event }) => event.type === "result")?.event.payload.status, "DONE");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Checks blocked transport remains unresolved and never applies pane disposition. */
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

