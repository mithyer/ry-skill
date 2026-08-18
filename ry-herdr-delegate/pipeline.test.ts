import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { PipelineStore, type PipelineRequestInput } from "./pipeline.ts";

/** Rejects malformed stage input before it can create a durable pipeline event log. */
test("PipelineStore rejects invalid stage payloads before durable creation", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-pipeline-validation-"));
	try {
		const store = new PipelineStore(root, "w-validation");
		const unknownField = {
			task: "validate payload",
			stages: [{ role: "worker", unsupported: true }],
		} as unknown as PipelineRequestInput;
		await assert.rejects(store.createRequest(unknownField, "pipeline-unknown"), /unknown field/);
		await assert.rejects(store.createRequest({
			task: "reject outside cwd",
			stages: [{ role: "worker", cwd: "../outside" }],
		}, "pipeline-outside-cwd"), /remain inside the project root/);
		await assert.rejects(store.createRequest({
			task: "reject outside resource",
			stages: [{ role: "worker", resourceKeys: ["cwd:/tmp/outside-project"] }],
		}, "pipeline-outside-resource"), /remain inside the project root/);
		await assert.rejects(access(join(store.pipelinesDirectory, "pipeline-unknown.jsonl")), { code: "ENOENT" });
		await assert.rejects(access(join(store.pipelinesDirectory, "pipeline-outside-cwd.jsonl")), { code: "ENOENT" });
		await assert.rejects(access(join(store.pipelinesDirectory, "pipeline-outside-resource.jsonl")), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Replays the normalized default stage exactly as it was persisted with the task event. */
test("PipelineStore round-trips a normalized default stage and inbox pointer", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-pipeline-roundtrip-"));
	try {
		const store = new PipelineStore(root, "w-roundtrip");
		const created = await store.createRequestAndEnqueue({
			task: "review the requested change",
			panePolicy: "keep",
			context: {
				role: "reviewer",
				agent: "claude",
				effort: "high",
				extraArgs: ["--fixture"],
				cwd: "docs",
				timeoutMs: 120_000,
			},
		}, "pipeline-roundtrip", "transaction-roundtrip", 8);
		const request = await store.readRequest("pipeline-roundtrip", 8);
		const inbox = await store.readInbox();
		assert.equal(request.task, "review the requested change");
		assert.equal(request.panePolicy, "keep");
		assert.deepEqual(request.stages, [{
			stageId: "legacy-stage-0",
			role: "reviewer",
			agent: "claude",
			effort: "high",
			extraArgs: ["--fixture"],
			cwd: "docs",
			timeoutMs: 120_000,
			panePolicy: "keep",
			dependsOn: [],
			dependencyMode: "legacy-serial",
			access: "workspace-write",
			resourceKeys: [],
		}]);
		assert.deepEqual(inbox, [{
			...created.entry,
			pipelineId: "pipeline-roundtrip",
			communicationFile: created.request.communicationFile,
			messageId: created.request.messageId,
			messageSeq: created.request.messageSeq,
			lineStart: created.request.lineStart,
			lineEnd: created.request.lineEnd,
			lineCount: created.request.lineCount,
			queueState: "queued",
		}]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Replays a reconciliation-result as the authoritative successor of an earlier PARTIAL stage result. */
test("PipelineStore replays reconciliation results after PARTIAL", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-pipeline-reconciliation-"));
	try {
		const store = new PipelineStore(root, "w-reconciliation");
		await store.createRequestAndEnqueue({
			task: "observe a stage",
			panePolicy: "keep",
			stages: [{ stageId: "stage-1", role: "worker", dependsOn: [], panePolicy: "keep" }],
		}, "pipeline-reconciliation", "transaction-reconciliation", 8);
		await store.appendPipelineEvent("pipeline-reconciliation", "stage-claimed", "coordinator", { status: "RUNNING", stageIndex: 0, stageId: "stage-1", attempt: 1, fencingToken: "fence-1", communicationFile: join(root, "stage.jsonl") }, undefined, { stageId: "stage-1", stageRole: "worker", stageOccurrence: 1, attempt: 1, fencingToken: "fence-1", schemaVersion: 2 });
		await store.appendPipelineEvent("pipeline-reconciliation", "result", "coordinator", { status: "PARTIAL", stageIndex: 0, stageId: "stage-1", attempt: 1, fencingToken: "fence-1", resultKey: "stage-result", summary: "late output" }, undefined, { stageId: "stage-1", stageRole: "worker", stageOccurrence: 1, attempt: 1, fencingToken: "fence-1", schemaVersion: 2 });
		await store.appendPipelineEvent("pipeline-reconciliation", "reconciliation-result", "coordinator", { status: "DONE", stageIndex: 0, stageId: "stage-1", attempt: 1, fencingToken: "fence-1", resultKey: "stage-result", recoverySeq: 1, supersedesEventId: "result-event", summary: "late output completed" }, undefined, { stageId: "stage-1", stageRole: "worker", stageOccurrence: 1, attempt: 1, fencingToken: "fence-1", schemaVersion: 2 });
		const progress = await store.readProgress("pipeline-reconciliation", 8);
		assert.equal(progress.stages[0]?.status, "DONE");
		assert.equal(progress.stages[0]?.summary, "late output completed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
