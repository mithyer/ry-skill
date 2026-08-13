import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseDelegateConfig } from "./config.ts";
import { PipelineCoordinator } from "./pipeline-coordinator.ts";
import { PipelineStore } from "./pipeline.ts";
import type {
	CreateTabInput,
	HerdrAgentOutput,
	HerdrAgentSnapshot,
	HerdrGateway,
	HerdrPane,
	HerdrSnapshot,
	MovePaneInput,
	PromptInput,
	SplitPaneInput,
	StartAgentInput,
	WaitInput,
} from "./types.ts";

/** Fake coordinator gateway with deterministic agent lifecycle and call tracing. */
class CoordinatorFakeGateway implements HerdrGateway {
	calls: string[] = [];
	closedAgent = false;
	startArgs: StartAgentInput[] = [];
	readonly agent: HerdrAgentSnapshot = {
		agent: "pipeline-coordinator-test",
		status: "idle",
		paneId: "w-test:p-coordinator",
		workspaceId: "w-test",
		tabId: "w-test:t1",
		cwd: "/tmp/project",
		agentSession: { kind: "path", source: "fake", value: "/tmp/coordinator.jsonl" },
	};

	private readonly onPrompt?: (prompt: PromptInput) => Promise<void> | void;
	private activeChild?: HerdrAgentSnapshot;
	private readonly child: HerdrAgentSnapshot = {
		agent: "worker-stage-test",
		status: "idle",
		paneId: "w-test:p-stage",
		workspaceId: "w-test",
		tabId: "w-test:t1",
		cwd: "/tmp/project",
		agentSession: { kind: "id", source: "fake", value: "stage-session" },
	};

	/** Creates a fake gateway. */
	constructor(onPrompt?: (prompt: PromptInput) => Promise<void> | void) {
		this.onPrompt = onPrompt;
	}
	async splitPane(input: SplitPaneInput): Promise<HerdrPane> {
		this.calls.push(`split:${input.sourcePaneId}`);
		return input.sourcePaneId === "w-test:p-coordinator" ? this.child : { paneId: "w-test:p-coordinator", workspaceId: "w-test", tabId: "w-test:t1" };
	}
	async startAgent(input: StartAgentInput): Promise<HerdrAgentSnapshot> {
		this.calls.push(`start:${input.kind}`);
		this.startArgs.push(input);
		if (input.kind === "pi") return this.agent;
		this.activeChild = { ...this.child, agent: input.name };
		return this.activeChild;
	}
	async prompt(input: PromptInput): Promise<HerdrAgentSnapshot | undefined> { this.calls.push(`prompt:${input.text.split("\n")[0]}`); if (input.target !== this.agent.agent) return this.activeChild; await this.onPrompt?.(input); return this.agent; }
	async waitFor(_input: WaitInput): Promise<HerdrAgentSnapshot> { this.calls.push("wait"); return this.activeChild ?? this.child; }
	async getAgent(target: string): Promise<HerdrAgentSnapshot> {
		this.calls.push(`get:${target}`);
		if (target === this.agent.agent && this.closedAgent) {
			const error = Object.assign(new Error("agent not found"), { code: 404 });
			throw error;
		}
		return target === this.agent.agent ? this.agent : { ...(this.activeChild ?? this.child), agent: target };
	}
	async readAgent(target: string): Promise<HerdrAgentOutput> { this.calls.push(`read:${target}`); return target === this.agent.agent ? { text: "" } : { text: "STATUS: DONE\nSUMMARY: stage complete\nVALIDATION: tests passed" }; }
	async createTab(_input: CreateTabInput): Promise<{ tabId: string; paneId?: string }> { this.calls.push("tab"); return { tabId: "w-test:t2" }; }
	async movePane(_input: MovePaneInput): Promise<{ tabId?: string }> { this.calls.push("move"); return { tabId: "w-test:t2" }; }
	async closePane(_paneId: string): Promise<void> { this.calls.push("close"); }
	async snapshot(): Promise<HerdrSnapshot> { this.calls.push("snapshot"); return { raw: {}, agents: [this.agent] }; }
}

/** Creates a coordinator manager with deterministic IDs and isolated state. */
async function makeCoordinator(root: string, gateway: HerdrGateway): Promise<{ coordinator: PipelineCoordinator; store: PipelineStore }> {
	const store = new PipelineStore(root, "w-test");
	let id = 0;
	const coordinator = new PipelineCoordinator({
		gateway,
		config: parseDelegateConfig({ version: 1 }),
		pipelineStore: store,
		id: () => `id-${++id}`,
	});
	return { coordinator, store };
}

/** Checks binding reuse, FIFO inbox persistence, and non-blocking QUEUED semantics. */
test("PipelineCoordinator reuses one binding and queues FIFO without waiting for stages", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-queued-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		const { coordinator, store } = await makeCoordinator(root, gateway);
		const first = await coordinator.submit({ task: "first" }, root, "w-test", "w-test:p-parent", root);
		const second = await coordinator.submit({ task: "second" }, root, "w-test", "w-test:p-parent", root);
		assert.equal(first.status, "QUEUED");
		assert.equal(second.status, "QUEUED");
	assert.equal(gateway.calls.filter((call) => call.startsWith("split:")).length, 1);
	assert.equal(gateway.calls.filter((call) => call === "start:pi").length, 1);
		const inbox = await store.readInbox();
		assert.deepEqual(inbox.map((entry) => entry.enqueueSeq), [1, 2]);
		assert.deepEqual(inbox.map((entry) => entry.pipelineId), [first.pipelineId, second.pipelineId]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Rejects recursive pipeline submission from the exact coordinator session. */
test("PipelineCoordinator blocks exact coordinator recursion", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-recursion-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		const { coordinator } = await makeCoordinator(root, gateway);
		const handle = await coordinator.ensure(root, "w-test", "w-test:p-parent", root);
		const result = await coordinator.submit({ task: "recursive" }, root, "w-test", handle.binding.paneId, root, undefined, handle.binding.agentSession);
		assert.equal(result.status, "BLOCKED");
		assert.match(result.error ?? "", /cannot submit another pipeline/);
		assert.equal(gateway.calls.filter((call) => call.startsWith("split:")).length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Refuses recovery when no prior coordinator binding can establish continuity. */
test("PipelineCoordinator recovery fails closed without a binding", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-recover-"));
	try {
		const { coordinator } = await makeCoordinator(root, new CoordinatorFakeGateway());
		const result = await coordinator.recover("pipeline-existing", root, "w-test", "w-test:p-parent", root);
		assert.equal(result.status, "BLOCKED");
		assert.match(result.error ?? "", /No coordinator binding/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
/** Checks workspace isolation and concurrent file bootstrap. */
test("CoordinatorStore isolates workspace state and bootstraps concurrently", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-store-"));
	try {
		const first = new PipelineStore(root, "workspace-a");
		const second = new PipelineStore(root, "workspace-b");
		assert.notEqual(first.coordinatorStore.stateDirectory, second.coordinatorStore.stateDirectory);
		await Promise.all(Array.from({ length: 4 }, () => first.coordinatorStore.ensure()));
		assert.equal((await first.coordinatorStore.read()), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Rejects traversal identifiers before any pipeline file is opened. */
test("PipelineStore rejects path traversal pipeline identifiers", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-pipeline-path-"));
	try {
		const store = new PipelineStore(root, "w-test");
		await assert.rejects(store.readState("../../outside"), /path-safe/);
		await assert.rejects(store.createRequest({ task: "unsafe" }, "../../outside"), /path-safe/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});


test("PipelineCoordinator ticks a queued stage exactly once", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-tick-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		const created = await makeCoordinator(root, gateway);
		const submission = await created.coordinator.submit({ task: "run stage" }, root, "w-test", "w-test:p-parent", root);
		const binding = await created.store.coordinatorStore.read();
		assert.ok(binding);
		const first = await created.coordinator.tick(binding);
		assert.equal(first.status, "DONE", JSON.stringify(first));
		const second = await created.coordinator.tick(binding);
		assert.equal(second.status, "ACCEPTED");
		const progress = await created.store.readProgress(submission.pipelineId, 8);
		assert.equal(progress.state.status, "DONE");
		assert.equal(progress.stages[0]?.status, "DONE");
		assert.equal(gateway.calls.filter((call) => call === "start:codex").length, 1);
		const events = (await import("./records.ts")).readEventLog(submission.communicationFile);
		const snapshot = await events;
		assert.equal(snapshot.events.filter(({ event }) => event.type === "accepted").length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});


test("PipelineCoordinator returns ACCEPTED only after a bounded coordinator acknowledgement", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-accepted-"));
	try {
		let store: PipelineStore;
		const gateway = new CoordinatorFakeGateway(async (prompt) => {
			if (prompt.text.includes("MESSAGE TYPE: pipeline-queued")) {
				const pipelineId = prompt.text.match(/PIPELINE ID: ([^\n]+)/)?.[1];
				if (pipelineId) await store.appendPipelineEvent(pipelineId, "accepted", "coordinator", { queueState: "accepted" });
			}
		});
		const created = await makeCoordinator(root, gateway);
		store = created.store;
		const submission = await created.coordinator.submit({ task: "accepted task" }, root, "w-test", "w-test:p-parent", root);
		assert.equal(submission.status, "ACCEPTED");
		const state = await store.readState(submission.pipelineId);
		assert.equal(state.status, "ACCEPTED");
		assert.ok(state.acceptedSeq);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Checks closed coordinator recovery reuses the exact saved session instead of creating a fresh one. */
test("PipelineCoordinator exact-resumes a definitively closed coordinator", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-recovery-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		const created = await makeCoordinator(root, gateway);
		const first = await created.coordinator.ensure(root, "w-test", "w-test:p-parent", root);
		gateway.closedAgent = true;
		const recovered = await created.coordinator.ensure(root, "w-test", "w-test:p-parent", root);
		assert.equal(recovered.created, true);
		assert.equal(recovered.binding.agent, first.binding.agent);
		assert.deepEqual(recovered.binding.agentSession, first.binding.agentSession);
		const recoveryArgs = gateway.startArgs.at(-1)?.agentArgs;
		assert.deepEqual(recoveryArgs?.slice(-2), ["--session", first.binding.agentSession.value]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});


test("PipelineCoordinator persists answer and stop controls", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-controls-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		const created = await makeCoordinator(root, gateway);
		const submission = await created.coordinator.submit({ task: "blocked task" }, root, "w-test", "w-test:p-parent", root);
		const binding = await created.store.coordinatorStore.read();
		assert.ok(binding);
		await created.store.appendPipelineEvent(submission.pipelineId, "result", "coordinator", {
			status: "BLOCKED", stageIndex: 0, stageRole: "worker", summary: "needs answer",
		}, undefined, { stageRole: "worker", stageOccurrence: 1, agentSession: { kind: "id", source: "fake", value: "stage-session" } });
		const answered = await created.coordinator.answer(submission.pipelineId, "continue", root, "w-test");
		assert.equal(answered.status, "ACCEPTED");
		const progress = await created.store.readProgress(submission.pipelineId, 8);
		assert.equal(progress.stages[0]?.answer, "continue");
		const stopped = await created.coordinator.stop(submission.pipelineId, root, "w-test");
		assert.equal(stopped.status, "STOPPED");
		const state = await created.store.readState(submission.pipelineId);
		assert.equal(state.status, "STOPPED");
		assert.equal(gateway.calls.includes("close"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
