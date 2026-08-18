import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { appendEvent, communicationIdFromPath, createEventLog, readEventLog, redactSensitivePayload } from "./records.ts";
import type { NewJsonlEvent } from "./types.ts";

/** Creates a valid event body shared by JSONL store tests. */
function newEvent(eventId: string, messageId?: string): NewJsonlEvent {
	return {
		schemaVersion: 1,
		eventId,
		messageId,
		timestamp: "2026-08-12T00:00:00.000Z",
		type: "task",
		actor: "parent",
		transaction: "tx-test",
		stageRole: "worker",
		stageOccurrence: 1,
		payload: { task: "hello", apiToken: "do-not-store" },
	};
}

/** Checks append/replay, physical line numbers, redaction, and idempotent retry. */
test("JSONL event store appends, replays, redacts, and deduplicates", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-records-"));
	const file = join(root, "communications", "worker-test.jsonl");
	try {
		await createEventLog(file);
		const first = await appendEvent(file, newEvent("evt-1", "msg-1"));
		const retry = await appendEvent(file, newEvent("evt-1", "msg-1"));
		const second = await appendEvent(file, newEvent("evt-2", "msg-2"));
		assert.equal(first.lineStart, 1);
		assert.equal(retry.idempotent, true);
		assert.equal(second.lineStart, 2);
		assert.equal(second.event.eventId, "evt-2");
		assert.equal((second.event.payload.apiToken), "[REDACTED]");
		assert.equal((await readEventLog(file)).events.length, 2);
		assert.equal(communicationIdFromPath(file), "worker-test");
		assert.match(await readFile(file, "utf8"), /"seq":1/);
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
	}
});

/** Checks resultKey idempotency ignores generated event identity but rejects semantic conflicts. */
test("JSONL result events deduplicate by resultKey", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-records-result-key-"));
	const file = join(root, "result.jsonl");
	const base: NewJsonlEvent = {
		schemaVersion: 2,
		eventId: "result-1",
		timestamp: "2026-08-12T00:00:00.000Z",
		type: "result",
		actor: "child-output-capture",
		transaction: "tx-result",
		stageRole: "worker",
		stageOccurrence: 1,
		payload: { resultKey: "[\"tx-result\",\"stage-1\",1,1,\"fence\",\"relay\"]", status: "DONE", summary: "same", validation: "passed" },
	};
	try {
		await appendEvent(file, base);
		const retry = await appendEvent(file, { ...base, eventId: "result-2", timestamp: "2026-08-12T00:01:00.000Z" });
		assert.equal(retry.idempotent, true);
		await assert.rejects(appendEvent(file, { ...base, eventId: "result-3", payload: { ...base.payload, summary: "different" } }), /result idempotency conflict/);
		assert.equal((await readEventLog(file)).events.length, 1);
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
	}
});

/** Checks conflicting event identities fail without appending another line. */
test("JSONL event store rejects idempotency conflicts", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-record-conflict-"));
	const file = join(root, "record.jsonl");
	try {
		await appendEvent(file, newEvent("evt-1", "msg-1"));
		await assert.rejects(appendEvent(file, { ...newEvent("evt-1", "msg-1"), payload: { task: "different" } }), /idempotency conflict/);
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
	}
});

/** Checks incomplete final lines are never silently ignored during replay. */
test("JSONL event store rejects an incomplete final line", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-record-tail-"));
	const file = join(root, "record.jsonl");
	try {
		await writeFile(file, '{"schemaVersion":1,"seq":1', "utf8");
		await assert.rejects(readEventLog(file), /incomplete final line/);
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
	}
});

/** Checks nested sensitive fields are redacted before persistence. */
test("payload redaction covers nested sensitive fields", () => {
	assert.deepEqual(redactSensitivePayload({ nested: { password: "secret", value: "ok" }, list: [{ token: "x" }] }), {
		nested: { password: "[REDACTED]", value: "ok" },
		list: [{ token: "[REDACTED]" }],
	});
});
