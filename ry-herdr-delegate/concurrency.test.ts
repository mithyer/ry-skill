import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { canonicalCwdResourceKey, WorkspaceReservationLedger } from "./concurrency.ts";
import { parseDelegateConfig } from "./config.ts";
import { normalizePipelineStages } from "./pipeline.ts";

/** Covers the version-1 configuration migration and the default bounded worker policy. */
test("concurrency configuration migrates v1 defaults and validates opt-out", () => {
	const migrated = parseDelegateConfig({ version: 1 });
	assert.equal(migrated.version, 2);
	assert.equal(migrated.configMigration, "v1-to-v2");
	assert.equal(migrated.pipelines.default.concurrency.enabled, true);
	assert.equal(migrated.pipelines.default.concurrency.maxAgents, 3);
	assert.equal(migrated.pipelines.default.concurrency.maxConcurrentStages, 3);
	const disabled = parseDelegateConfig({ version: 2, pipelines: { default: { concurrency: { enabled: false } } } });
	assert.equal(disabled.pipelines.default.concurrency.enabled, false);
});

/** Verifies omitted dependencies remain serial while explicit empty dependencies are parallel-ready. */
test("pipeline stage normalization preserves legacy serial and explicit parallel semantics", () => {
	const legacy = normalizePipelineStages([{ role: "worker" }, { role: "worker" }]);
	assert.deepEqual(legacy.map((stage) => ({ id: stage.stageId, dependsOn: stage.dependsOn, mode: stage.dependencyMode })), [
		{ id: "legacy-stage-0", dependsOn: [], mode: "legacy-serial" },
		{ id: "legacy-stage-1", dependsOn: ["legacy-stage-0"], mode: "legacy-serial" },
	]);
	const parallel = normalizePipelineStages([
		{ stageId: "inspect", role: "worker", dependsOn: [] },
		{ stageId: "verify", role: "worker", dependsOn: [] },
	]);
	assert.deepEqual(parallel.map((stage) => stage.dependsOn), [[], []]);
	assert.throws(() => normalizePipelineStages([
		{ stageId: "a", role: "worker", dependsOn: ["b"] },
		{ stageId: "b", role: "worker", dependsOn: ["a"] },
	]), /dependency cycle/);
});

/** Verifies canonical cwd ownership is stable for resource reservations. */
test("canonical cwd resource keys are absolute and stable", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-concurrency-cwd-"));
	try {
		const key = await canonicalCwdResourceKey(root);
		assert.equal(key, `cwd:${await realpath(root)}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Ensures resource ownership remains stable while a caller supplies a nonexistent cwd tail. */
test("canonical cwd resource keys preserve nonexistent path tails", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-concurrency-missing-cwd-"));
	try {
		const existing = join(root, "existing");
		await mkdir(existing);
		const key = await canonicalCwdResourceKey(join(existing, "future", "child"));
		assert.equal(key, `cwd:${await realpath(existing)}/future/child`);
		assert.equal(await canonicalCwdResourceKey(""), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Verifies workspace reservations serialize conflicting writes and release safely. */
test("workspace reservation ledger enforces resource conflicts and release", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-concurrency-ledger-"));
	try {
		const ledger = new WorkspaceReservationLedger(root, "w-test");
		const expiresAt = new Date(Date.now() + 600_000).toISOString();
		const first = await ledger.claim({
			reservationId: "reservation-first",
			pipelineId: "pipeline-first",
			stageId: "stage-first",
			attempt: 1,
			fencingToken: "fence-first",
			reservedSlots: 1,
			expiresAt,
			access: "workspace-write",
			resourceKeys: ["cwd:/tmp/project"],
			ownerEpoch: "owner-first",
		}, { maxAgents: 3 });
		assert.equal(first.committed, true);
		assert.equal(first.reservation?.expiresAt, expiresAt);
		const conflict = await ledger.claim({
			reservationId: "reservation-conflict",
			pipelineId: "pipeline-conflict",
			stageId: "stage-conflict",
			attempt: 1,
			fencingToken: "fence-conflict",
			reservedSlots: 1,
			expiresAt,
			access: "workspace-write",
			resourceKeys: ["cwd:/tmp/project"],
			ownerEpoch: "owner-conflict",
		}, { maxAgents: 3 });
		assert.equal(conflict.committed, false);
		assert.equal(conflict.reason, "resource-conflict");
		assert.equal(await ledger.release("reservation-first", "owner-first", "fence-first"), true);
		const afterRelease = await ledger.claim({
			reservationId: "reservation-after-release",
			pipelineId: "pipeline-after-release",
			stageId: "stage-after-release",
			attempt: 1,
			fencingToken: "fence-after-release",
			reservedSlots: 1,
			expiresAt,
			access: "workspace-write",
			resourceKeys: ["cwd:/tmp/project"],
			ownerEpoch: "owner-after-release",
		}, { maxAgents: 3 });
		assert.equal(afterRelease.committed, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Enforces lease expiry and reconciles orphaned reservations without retaining capacity forever. */
test("workspace reservation ledger expires and reconciles orphaned leases", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-concurrency-expiry-"));
	let now = new Date("2026-01-01T00:00:00.000Z");
	try {
		const ledger = new WorkspaceReservationLedger(root, "w-expiry", { now: () => now });
		const expiresAt = new Date(now.getTime() + 1000).toISOString();
		const claimed = await ledger.claim({
			reservationId: "reservation-expiring",
			pipelineId: "pipeline-expiring",
			stageId: "stage-expiring",
			attempt: 1,
			fencingToken: "fence-expiring",
			reservedSlots: 1,
			expiresAt,
			access: "workspace-write",
			resourceKeys: ["cwd:/tmp/expiring"],
			ownerEpoch: "owner-expiring",
		}, { maxAgents: 1 });
		assert.equal(claimed.committed, true);
		now = new Date("2026-01-01T00:00:02.000Z");
		assert.equal((await ledger.active()).at(0)?.state, "orphan-pending");
		await ledger.reconcile(new Set());
		assert.equal((await ledger.active()).length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Ensures renewal is owner-fenced and keeps an otherwise expired lease active. */
test("workspace reservation ledger heartbeats renew only the current owner lease", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-concurrency-heartbeat-"));
	let now = new Date("2026-01-01T00:00:00.000Z");
	try {
		const ledger = new WorkspaceReservationLedger(root, "w-heartbeat", { now: () => now });
		const initialExpiry = new Date(now.getTime() + 1_000).toISOString();
		const renewedExpiry = new Date(now.getTime() + 10_000).toISOString();
		const claim = {
			reservationId: "reservation-heartbeat",
			pipelineId: "pipeline-heartbeat",
			stageId: "stage-heartbeat",
			attempt: 1,
			fencingToken: "fence-heartbeat",
			reservedSlots: 1,
			expiresAt: initialExpiry,
			access: "workspace-write" as const,
			resourceKeys: ["cwd:/tmp/heartbeat"],
			ownerEpoch: "owner-heartbeat",
		};
		assert.equal((await ledger.claim(claim, { maxAgents: 1 })).committed, true);
		assert.equal(await ledger.heartbeat(claim.reservationId, "stale-owner", renewedExpiry), false);
		assert.equal(await ledger.heartbeat(claim.reservationId, claim.ownerEpoch, renewedExpiry), true);
		now = new Date("2026-01-01T00:00:02.000Z");
		const active = await ledger.active();
		assert.equal(active.length, 1);
		assert.equal(active[0]?.state, "active");
		assert.equal(active[0]?.expiresAt, renewedExpiry);
		assert.equal(active[0]?.lastHeartbeatAt, "2026-01-01T00:00:00.000Z");
		assert.equal(await ledger.release(claim.reservationId, claim.ownerEpoch, "stale-fence"), false);
		assert.equal(await ledger.release(claim.reservationId, claim.ownerEpoch, claim.fencingToken), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
