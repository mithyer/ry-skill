import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { createDebugLogger, debug, withDebugLogger } from "./debug.ts";
import type { SessionIdentity } from "./types.ts";

/** Creates deterministic logger options for one isolated temporary debug directory. */
function loggerOptions(directory: string, session: SessionIdentity, level: "off" | "error" | "warn" | "info" | "debug" | "trace" = "trace") {
	return {
		config: { level, directory },
		cwd: directory,
		projectRoot: directory,
		piSession: session,
		piVersion: "test-pi",
		rySkillVersion: "test-ry-skill",
	};
}

/** Reads the JSONL debug records written by a test logger. */
async function readDebugRecords(file: string): Promise<Array<Record<string, unknown>>> {
	return (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Checks that the logger, rather than callers, adds usable source-location metadata. */
function assertAutomaticCallsite(value: unknown): void {
	assert.ok(value && typeof value === "object");
	const callsite = value as Record<string, unknown>;
	assert.match(String(callsite.file), /ry-herdr-delegate[\\/]debug\.test\.ts$/);
	assert.match(String(callsite.method), /TestContext/);
	assert.ok(typeof callsite.line === "number" && callsite.line > 0);
	assert.ok(typeof callsite.column === "number" && callsite.column > 0);
}

/** Checks that each exact Pi session receives a readable independent log file. */
test("debug logger reuses session-named file and increments only on identity collision", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-debug-"));
	try {
		const directory = join(root, "debug");
		const first: SessionIdentity = { kind: "path", source: "herdr:pi", value: "/sessions/project/run.jsonl" };
		const sameSession = await createDebugLogger(loggerOptions(directory, first));
		const reusedSession = await createDebugLogger(loggerOptions(directory, first));
		const colliding: SessionIdentity = { kind: "path", source: "herdr:pi", value: "/other-project/run.jsonl" };
		const collidingSession = await createDebugLogger(loggerOptions(directory, colliding));

		assert.ok(sameSession.file);
		assert.equal(reusedSession.file, sameSession.file);
		assert.equal(basename(sameSession.file), "run.jsonl");
		assert.equal(basename(collidingSession.file!), "run-2.jsonl");
		const context = (await readDebugRecords(sameSession.file))[0];
		assert.equal(context.recordType, "debug-context");
		assert.deepEqual((context.context as Record<string, unknown>).debugSession, first);
		assertAutomaticCallsite(context.callsite);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Checks that verbosity filtering does not write events above the configured level. */
test("debug logger filters events above configured level", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-debug-level-"));
	try {
		const logger = await createDebugLogger(loggerOptions(join(root, "debug"), { kind: "path", source: "herdr:pi", value: "/sessions/info.jsonl" }, "info"));
		assert.ok(logger.file);
		await logger.log("request.completed", {}, "info");
		await logger.log("stage.checkpoint", {}, "debug");
		await logger.log("command.stdout", {}, "trace");
		const records = await readDebugRecords(logger.file);
		assert.deepEqual(records.map((record) => record.recordLevel), ["info", "info"]);
		assertAutomaticCallsite(records[1].callsite);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Checks that the request-scoped facade captures a business caller, not its logger wrapper. */
test("debug facade automatically captures the business callsite", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-debug-facade-"));
	try {
		const logger = await createDebugLogger(loggerOptions(join(root, "debug"), { kind: "path", source: "herdr:pi", value: "/sessions/facade.jsonl" }));
		assert.ok(logger.file);
		await withDebugLogger(logger, async () => {
			await debug.log("facade.business-event", { operation: "test" }, "info");
		});
		const records = await readDebugRecords(logger.file);
		const record = records.at(-1);
		assert.equal(record?.event, "facade.business-event");
		assertAutomaticCallsite(record?.callsite);
		assert.notEqual((record?.callsite as Record<string, unknown>).file, "ry-herdr-delegate/debug.ts");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Checks the global facade isolates host logger failures from runtime callers. */
test("debug facade swallows custom logger failures", async () => {
	const throwingLogger = {
		level: "trace" as const,
		enabled: true,
		file: "/tmp/debug.jsonl",
		log: async (): Promise<void> => { throw new Error("debug sink unavailable"); },
	};
	await withDebugLogger(throwingLogger, async () => {
		await debug.log("facade.throwing-sink", {}, "info");
	});
});

/** Checks that off mode performs no debug directory or file creation. */
test("debug logger off mode creates no session log", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-debug-off-"));
	try {
		const directory = join(root, "debug");
		const logger = await createDebugLogger(loggerOptions(directory, { kind: "path", source: "herdr:pi", value: "/sessions/off.jsonl" }, "off"));
		assert.equal(logger.enabled, false);
		assert.equal(logger.file, undefined);
		await assert.rejects(readFile(directory, "utf8"), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
