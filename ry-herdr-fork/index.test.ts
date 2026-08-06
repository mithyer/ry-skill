import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager, type SessionHeader } from "@earendil-works/pi-coding-agent";

import {
	createForkSession,
	extractForkCandidates,
	launchForkInHerdr,
	type CommandExecutor,
} from "./index.ts";

/** Zero-valued usage metadata for persisted assistant test messages. */
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

/**
 * Appends a completed assistant response so SessionManager flushes the fixture.
 *
 * @param manager Session manager receiving the assistant entry.
 * @param text Assistant response text.
 * @returns Identifier of the appended assistant entry.
 */
function appendAssistant(manager: SessionManager, text: string): string {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

/**
 * Creates a two-turn persisted source session for fork tests.
 *
 * @param root Temporary test root.
 * @returns Source manager and important message identifiers.
 */
function createSourceSession(root: string): {
	manager: SessionManager;
	firstUserId: string;
	firstAssistantId: string;
	secondUserId: string;
} {
	const sessionDir = join(root, "sessions");
	const manager = SessionManager.create(root, sessionDir, { id: "source-session" });
	const firstUserId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
	const firstAssistantId = appendAssistant(manager, "first answer");
	const secondUserId = manager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "second" },
			{ type: "text", text: " prompt" },
		],
		timestamp: Date.now(),
	});
	appendAssistant(manager, "second answer");
	return { manager, firstUserId, firstAssistantId, secondUserId };
}

/**
 * Parses every JSONL record in a session fixture.
 *
 * @param path Session file path.
 * @returns Parsed session records in file order.
 */
async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
	const content = await readFile(path, "utf8");
	return content
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("extractForkCandidates mirrors Pi user-message selection", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-fork-candidates-"));
	try {
		const { manager, firstUserId, secondUserId } = createSourceSession(root);
		assert.deepEqual(extractForkCandidates(manager.getEntries()), [
			{ entryId: firstUserId, text: "first prompt", parentId: null },
			{
				entryId: secondUserId,
				text: "second prompt",
				parentId: manager.getEntry(secondUserId)?.parentId ?? null,
			},
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createForkSession truncates before selected message without changing source", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-fork-truncate-"));
	try {
		const { manager, firstUserId, firstAssistantId, secondUserId } = createSourceSession(root);
		const sourceFile = manager.getSessionFile();
		assert.ok(sourceFile);
		const sourceBefore = await readFile(sourceFile, "utf8");
		const sourceLeafBefore = manager.getLeafId();

		const prepared = await createForkSession(manager, secondUserId);
		const forkEntries = await readJsonLines(prepared.sessionFile);
		const forkHeader = forkEntries[0] as unknown as SessionHeader;

		assert.equal(prepared.prompt, "second prompt");
		assert.equal(forkHeader.parentSession, sourceFile);
		assert.deepEqual(
			forkEntries.slice(1).map((entry) => entry.id),
			[firstUserId, firstAssistantId],
		);
		assert.equal(await readFile(sourceFile, "utf8"), sourceBefore);
		assert.equal(manager.getSessionFile(), sourceFile);
		assert.equal(manager.getLeafId(), sourceLeafBefore);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createForkSession supports forking before the root message", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-fork-root-"));
	try {
		const { manager, firstUserId } = createSourceSession(root);
		const sourceFile = manager.getSessionFile();
		assert.ok(sourceFile);

		const prepared = await createForkSession(manager, firstUserId);
		const forkEntries = await readJsonLines(prepared.sessionFile);
		const forkHeader = forkEntries[0] as unknown as SessionHeader;

		assert.equal(prepared.prompt, "first prompt");
		assert.equal(forkHeader.parentSession, sourceFile);
		assert.equal(forkEntries.length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("launchForkInHerdr opens partial session and restores editor text", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const execute: CommandExecutor = async (command, args) => {
		calls.push({ command, args });
		if (args[0] === "tab" && args[1] === "create") {
			return {
				stdout: JSON.stringify({
					result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } },
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		}
		return { stdout: "{}", stderr: "", code: 0, killed: false };
	};

	const result = await launchForkInHerdr(
		{ cwd: "/tmp/project", sessionFile: "/tmp/fork.jsonl", prompt: "editable prompt" },
		{
			execute,
			env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
			now: () => new Date(2026, 7, 6, 12, 34, 56),
			uniqueSuffix: () => "abc123",
		},
	);

	assert.deepEqual(result, {
		tab: "w1:t2",
		pane: "w1:p2",
		agent: "fork-123456-abc123",
		session: "/tmp/fork.jsonl",
	});
	assert.deepEqual(calls[1], {
		command: "herdr",
		args: [
			"agent",
			"start",
			"fork-123456-abc123",
			"--kind",
			"pi",
			"--pane",
			"w1:p2",
			"--",
			"--session",
			"/tmp/fork.jsonl",
			"--name",
			"fork-123456",
		],
	});
	assert.deepEqual(calls[2], {
		command: "herdr",
		args: ["pane", "send-text", "w1:p2", "--", "editable prompt"],
	});
});

test("launchForkInHerdr retries a newly created busy pane", async () => {
	let startAttempts = 0;
	let sleepCalls = 0;
	const execute: CommandExecutor = async (_command, args) => {
		if (args[0] === "tab" && args[1] === "create") {
			return {
				stdout: JSON.stringify({
					result: { tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p3" } },
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		}
		if (args[0] === "agent" && args[1] === "start") {
			startAttempts++;
			if (startAttempts === 1) {
				return {
					stdout: "",
					stderr: '{"error":{"code":"agent_pane_busy"}}',
					code: 1,
					killed: false,
				};
			}
		}
		return { stdout: "{}", stderr: "", code: 0, killed: false };
	};

	const result = await launchForkInHerdr(
		{ cwd: "/tmp/project", sessionFile: "/tmp/fork.jsonl", prompt: "prompt" },
		{
			execute,
			env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
			uniqueSuffix: () => "busy",
			sleep: async () => {
				sleepCalls++;
			},
		},
	);

	assert.equal(result.tab, "w1:t3");
	assert.equal(startAttempts, 2);
	assert.equal(sleepCalls, 1);
});

test("launchForkInHerdr closes its tab when startup fails", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const execute: CommandExecutor = async (command, args) => {
		calls.push({ command, args });
		if (args[0] === "tab" && args[1] === "create") {
			return {
				stdout: JSON.stringify({
					result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } },
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		}
		if (args[0] === "agent" && args[1] === "start") {
			return { stdout: "", stderr: "agent failed", code: 1, killed: false };
		}
		return { stdout: "{}", stderr: "", code: 0, killed: false };
	};

	await assert.rejects(
		launchForkInHerdr(
			{ cwd: "/tmp/project", sessionFile: "/tmp/fork.jsonl", prompt: "prompt" },
			{
				execute,
				env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
				uniqueSuffix: () => "failure",
			},
		),
		/herdr agent start failed: agent failed/,
	);
	assert.deepEqual(calls.at(-1), { command: "herdr", args: ["tab", "close", "w1:t9"] });
});
