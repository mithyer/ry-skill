import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseDelegateConfig } from "./config.ts";
import { COORDINATOR_BOOTSTRAP, PipelineCoordinator } from "./pipeline-coordinator.ts";
import { appendEvent, createEventLog, createEventLogEvent } from "./records.ts";
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
	waitDelayMs = 0;
	activeWaits = 0;
	maxConcurrentWaits = 0;
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
	async waitFor(_input: WaitInput): Promise<HerdrAgentSnapshot> {
		this.calls.push("wait");
		this.activeWaits += 1;
		this.maxConcurrentWaits = Math.max(this.maxConcurrentWaits, this.activeWaits);
		if (this.waitDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.waitDelayMs));
		this.activeWaits -= 1;
		return this.activeChild ?? this.child;
	}
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

/** Ensures a coordinator child uses the structured scheduling boundary instead of mutating JSONL directly. */
test("COORDINATOR_BOOTSTRAP delegates durable writes to the structured tool", () => {
	assert.match(COORDINATOR_BOOTSTRAP, /ry_herdr_delegate_tool exactly once with action pipeline\.coordinator/);
	assert.match(COORDINATOR_BOOTSTRAP, /Do not directly read, write, append, edit, or repair pipeline JSONL/);
	assert.doesNotMatch(COORDINATOR_BOOTSTRAP, /append the event to the authoritative JSONL log/);
	assert.doesNotMatch(COORDINATOR_BOOTSTRAP, /Use only the leaf delegate action/);
});

/** Creates a coordinator manager with deterministic IDs and isolated state. */
async function makeCoordinator(root: string, gateway: HerdrGateway, configInput: unknown = { version: 1 }): Promise<{ coordinator: PipelineCoordinator; store: PipelineStore }> {
	const store = new PipelineStore(root, "w-test");
	let id = 0;
	const coordinator = new PipelineCoordinator({
		gateway,
		config: parseDelegateConfig(configInput),
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


/** Repairs a fully written pipeline log when the process crashed before inbox commit. */
test("PipelineStore reconciles an orphaned request into the FIFO inbox", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-pipeline-orphan-"));
	try {
		const store = new PipelineStore(root, "w-test");
		const request = await store.createRequest({ task: "orphaned request" }, "pipeline-orphaned", "pipeline-orphaned", 8);
		const inbox = await store.readInbox();
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0]?.pipelineId, "pipeline-orphaned");
		assert.equal(inbox[0]?.messageSeq, request.messageSeq);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
/** Derives a terminal pipeline status when a crash leaves only a stage-indexed result. */
test("PipelineStore aggregates stage-indexed failures into pipeline status", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-pipeline-aggregate-"));
	try {
		const store = new PipelineStore(root, "w-test");
		await store.createRequest({ task: "aggregate status" }, "pipeline-aggregate", "pipeline-aggregate", 8);
		await store.appendPipelineEvent("pipeline-aggregate", "result", "coordinator", { status: "ERROR", stageIndex: 0, stageId: "legacy-stage-0", error: "stage failed" });
		assert.equal((await store.readState("pipeline-aggregate")).status, "ERROR");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

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
		await created.store.appendPipelineEvent(submission.pipelineId, "pipeline.control", "parent", { action: "stop", controlId: "stale-stop", targetScope: "pipeline", targetStageIds: [], pipelineFence: "stale-writer-fence", expected: [] }, "stale-stop");
		const staleBinding = { ...binding, writerFence: "stale-writer-fence" };
		const staleTick = await created.coordinator.tick(staleBinding);
		assert.equal(staleTick.status, "BLOCKED");
		const first = await created.coordinator.tick(binding);
		assert.equal(first.status, "DONE", JSON.stringify(first));
		const second = await created.coordinator.tick(binding);
		assert.equal(second.status, "ACCEPTED");
		const progress = await created.store.readProgress(submission.pipelineId, 8, binding.writerFence);
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




/** Keeps a fully serial explicit DAG runnable when concurrency is explicitly disabled. */
test("PipelineCoordinator runs a serial explicit DAG with concurrency disabled", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-serial-optout-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		const created = await makeCoordinator(root, gateway, { version: 2, pipelines: { default: { concurrency: { enabled: false } } } });
		const submission = await created.coordinator.submit({
			task: "serial explicit plan",
			stages: [
				{ stageId: "first", role: "worker", task: "first", dependsOn: [], resourceKeys: ["resource:first"] },
				{ stageId: "second", role: "worker", task: "second", dependsOn: ["first"], resourceKeys: ["resource:second"] },
			],
		}, root, "w-test", "w-test:p-parent", root);
		const binding = await created.store.coordinatorStore.read();
		assert.ok(binding);
		assert.equal((await created.coordinator.tick(binding)).status, "RUNNING");
		assert.equal((await created.coordinator.tick(binding)).status, "DONE");
		assert.deepEqual((await created.store.readProgress(submission.pipelineId, 8)).stages.map((stage) => stage.status), ["DONE", "DONE"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("PipelineCoordinator enforces maxPipelines while claiming multiple inbox entries", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-pipeline-quota-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		const created = await makeCoordinator(root, gateway, { version: 2, pipelines: { default: { concurrency: { maxPipelines: 2, maxAgents: 2, maxConcurrentStages: 1 } } } });
		const first = await created.coordinator.submit({ task: "first quota pipeline", stages: [{ role: "worker", resourceKeys: ["resource:first"] }] }, root, "w-test", "w-test:p-parent", root);
		const second = await created.coordinator.submit({ task: "second quota pipeline", stages: [{ role: "worker", resourceKeys: ["resource:second"] }] }, root, "w-test", "w-test:p-parent", root);
		const binding = await created.store.coordinatorStore.read();
		assert.ok(binding);
		const result = await created.coordinator.tick(binding);
		assert.equal(result.status, "DONE", JSON.stringify(result));
		assert.equal(result.stagesProcessed, 2);
		assert.deepEqual((await created.store.readProgress(first.pipelineId, 8)).stages.map((stage) => stage.status), ["DONE"]);
		assert.deepEqual((await created.store.readProgress(second.pipelineId, 8)).stages.map((stage) => stage.status), ["DONE"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("PipelineCoordinator fences a late stage result after stop", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-stop-race-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		gateway.waitDelayMs = 100;
		const created = await makeCoordinator(root, gateway);
		const submission = await created.coordinator.submit({ task: "stop race" }, root, "w-test", "w-test:p-parent", root);
		const binding = await created.store.coordinatorStore.read();
		assert.ok(binding);
		const tickPromise = created.coordinator.tick(binding);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const stopped = await created.coordinator.stop(submission.pipelineId, root, "w-test");
		const tick = await tickPromise;
		assert.equal(stopped.status, "STOPPED");
		assert.equal(tick.status, "STOPPED");
		assert.equal((await created.store.readState(submission.pipelineId)).status, "STOPPED");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("PipelineCoordinator executes an explicit parallel ready wave", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-parallel-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		gateway.waitDelayMs = 50;
		const created = await makeCoordinator(root, gateway);
		const submission = await created.coordinator.submit({
			task: "run independent stages",
			stages: [
				{ stageId: "inspect", role: "worker", task: "inspect", dependsOn: [], resourceKeys: ["resource:inspect"] },
				{ stageId: "verify", role: "worker", task: "verify", dependsOn: [], resourceKeys: ["resource:verify"] },
			],
		}, root, "w-test", "w-test:p-parent", root);
		const binding = await created.store.coordinatorStore.read();
		assert.ok(binding);
		const result = await created.coordinator.tick(binding);
		assert.equal(result.status, "DONE", JSON.stringify(result));
		assert.equal(result.stagesProcessed, 2);
		const progress = await created.store.readProgress(submission.pipelineId, 8);
		assert.deepEqual(progress.stages.map((stage) => stage.status), ["DONE", "DONE"]);
		assert.ok(progress.stages.every((stage) => stage.communicationFile?.startsWith(created.store.coordinatorStore.stateDirectory)));
		assert.equal(gateway.calls.filter((call) => call === "start:codex").length, 2);
		assert.equal(gateway.maxConcurrentWaits, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Persists answer and stop controls for a blocked pipeline. */
test("PipelineCoordinator persists answer and stop controls", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-coordinator-controls-"));
	try {
		const gateway = new CoordinatorFakeGateway();
		const created = await makeCoordinator(root, gateway);
		const submission = await created.coordinator.submit({ task: "blocked task" }, root, "w-test", "w-test:p-parent", root);
		const binding = await created.store.coordinatorStore.read();
		assert.ok(binding);
		const stageFile = join(created.store.coordinatorStore.stateDirectory, "communications", "stage-continuation.jsonl");
		const stageSession = { kind: "id" as const, source: "fake", value: "stage-session" };
		await createEventLog(stageFile);
		await appendEvent(stageFile, createEventLogEvent(submission.pipelineId, "worker", 1));
		await appendEvent(stageFile, {
			schemaVersion: 1,
			eventId: "stage-checkpoint",
			timestamp: new Date().toISOString(),
			type: "checkpoint",
			actor: "coordinator",
			transaction: submission.pipelineId,
			stageRole: "worker",
			stageOccurrence: 1,
			agentSession: stageSession,
			payload: { operation: "wait", transportStatus: "blocked" },
		});
		await created.store.appendPipelineEvent(submission.pipelineId, "result", "coordinator", {
			status: "BLOCKED", stageIndex: 0, stageRole: "worker", summary: "needs answer", communicationFile: stageFile, paneId: "w-test:p-stage", agent: "worker-stage-test", agentSession: stageSession,
		}, undefined, { stageRole: "worker", stageOccurrence: 1, agentSession: stageSession });
		const answered = await created.coordinator.answer(submission.pipelineId, "continue", root, "w-test");
		assert.equal(answered.status, "ACCEPTED");
		const progress = await created.store.readProgress(submission.pipelineId, 8);
		assert.equal(progress.stages[0]?.answer, "continue");
		const resumed = await created.coordinator.tick(binding);
		assert.equal(resumed.status, "DONE", JSON.stringify(resumed));
		const resumedProgress = await created.store.readProgress(submission.pipelineId, 8);
		assert.equal(resumedProgress.stages[0]?.status, "DONE");
		const stopped = await created.coordinator.stop(submission.pipelineId, root, "w-test");
		assert.equal(stopped.status, "DONE");
		const state = await created.store.readState(submission.pipelineId);
		assert.equal(state.status, "DONE");
		assert.equal(gateway.calls.includes("close"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
