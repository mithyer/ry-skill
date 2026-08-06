import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager, type SessionHeader } from "@earendil-works/pi-coding-agent";

import ryHerdrClone, {
	createCloneSession,
	launchCloneInHerdr,
	runCloneFlow,
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
 * Creates a two-turn persisted source session for clone tests.
 *
 * @param root Temporary test root.
 * @returns Source manager and important message identifiers.
 */
function createSourceSession(root: string): {
	manager: SessionManager;
	firstUserId: string;
	firstAssistantId: string;
	secondUserId: string;
	secondAssistantId: string;
} {
	const sessionDir = join(root, "sessions");
	const manager = SessionManager.create(root, sessionDir, { id: "clone-source-session" });
	const firstUserId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
	const firstAssistantId = appendAssistant(manager, "first answer");
	const secondUserId = manager.appendMessage({ role: "user", content: "second prompt", timestamp: Date.now() });
	const secondAssistantId = appendAssistant(manager, "second answer");
	return { manager, firstUserId, firstAssistantId, secondUserId, secondAssistantId };
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

test("createCloneSession copies only the active branch without changing source", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-clone-branch-"));
	try {
		const { manager, firstUserId, firstAssistantId } = createSourceSession(root);
		manager.branch(firstAssistantId);
		const sourceFile = manager.getSessionFile();
		assert.ok(sourceFile);
		const sourceBefore = await readFile(sourceFile, "utf8");
		const sourceLeafBefore = manager.getLeafId();

		const prepared = await createCloneSession(manager);
		const cloneRecords = await readJsonLines(prepared.sessionFile);
		const cloneHeader = cloneRecords[0] as unknown as SessionHeader;

		assert.equal(cloneHeader.parentSession, sourceFile);
		assert.deepEqual(
			cloneRecords.slice(1).map((entry) => entry.id),
			[firstUserId, firstAssistantId],
		);
		assert.equal(await readFile(sourceFile, "utf8"), sourceBefore);
		assert.equal(manager.getSessionFile(), sourceFile);
		assert.equal(manager.getLeafId(), sourceLeafBefore);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createCloneSession persists an active branch without an assistant", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-clone-deferred-"));
	try {
		const { manager, firstUserId } = createSourceSession(root);
		manager.branch(firstUserId);
		const sourceFile = manager.getSessionFile();
		assert.ok(sourceFile);

		const prepared = await createCloneSession(manager);
		const cloneRecords = await readJsonLines(prepared.sessionFile);
		const cloneHeader = cloneRecords[0] as unknown as SessionHeader;

		assert.equal(cloneHeader.parentSession, sourceFile);
		assert.deepEqual(cloneRecords.slice(1).map((entry) => entry.id), [firstUserId]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createCloneSession rejects a session without a current entry", async () => {
	const manager = SessionManager.inMemory("/tmp/empty-clone");
	await assert.rejects(createCloneSession(manager), /Nothing to clone yet/);
});

test("launchCloneInHerdr opens the clone with an empty editor", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const execute: CommandExecutor = async (command, args) => {
		calls.push({ command, args });
		if (args[0] === "tab" && args[1] === "create") {
			return {
				stdout: JSON.stringify({
					result: { tab: { tab_id: "w1:t4" }, root_pane: { pane_id: "w1:p4" } },
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		}
		return { stdout: "{}", stderr: "", code: 0, killed: false };
	};

	const result = await launchCloneInHerdr(
		{ cwd: "/tmp/project", sessionFile: "/tmp/clone.jsonl" },
		{
			execute,
			env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
			now: () => new Date(2026, 7, 6, 12, 34, 56),
			uniqueSuffix: () => "def456",
		},
	);

	assert.deepEqual(result, {
		tab: "w1:t4",
		pane: "w1:p4",
		agent: "clone-123456-def456",
		session: "/tmp/clone.jsonl",
	});
	assert.deepEqual(calls[1], {
		command: "herdr",
		args: [
			"agent",
			"start",
			"clone-123456-def456",
			"--kind",
			"pi",
			"--pane",
			"w1:p4",
			"--",
			"--session",
			"/tmp/clone.jsonl",
			"--name",
			"clone-123456",
		],
	});
	assert.equal(calls.length, 2, "clone must not inject text into the new editor");
});

test("runCloneFlow removes the clone file when Herdr startup fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "ry-herdr-clone-cleanup-"));
	try {
		const { manager } = createSourceSession(root);
		const sessionDir = manager.getSessionDir();
		const filesBefore = (await readdir(sessionDir)).sort();
		const execute: CommandExecutor = async (_command, args) => {
			if (args[0] === "tab" && args[1] === "create") {
				return {
					stdout: JSON.stringify({
						result: { tab: { tab_id: "w1:t8" }, root_pane: { pane_id: "w1:p8" } },
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
			runCloneFlow(
				{
					mode: "tui",
					cwd: root,
					sessionManager: manager,
				} as never,
				execute,
			),
			/herdr agent start failed: agent failed/,
		);
		assert.deepEqual((await readdir(sessionDir)).sort(), filesBefore);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ryHerdrClone intercepts its skill invocation while busy", async () => {
	type InputHandler = (
		event: { text: string },
		ctx: { isIdle: () => boolean; ui: { notify: (message: string, level: string) => void } },
	) => Promise<unknown>;
	let inputHandler: InputHandler | undefined;
	const notifications: Array<{ message: string; level: string }> = [];

	// Only registration behavior is needed here; the busy path must finish before
	// any session or Herdr dependency is accessed.
	ryHerdrClone({
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		registerCommand: () => undefined,
		on: (event: string, handler: unknown) => {
			if (event === "input") {
				inputHandler = handler as InputHandler;
			}
		},
	} as never);

	assert.ok(inputHandler);
	const result = await inputHandler(
		{ text: " /skill:ry-herdr-clone " },
		{
			isIdle: () => false,
			ui: {
				notify: (message, level) => notifications.push({ message, level }),
			},
		},
	);

	assert.deepEqual(result, { action: "handled" });
	assert.equal(notifications[0]?.level, "warning");
});
