import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseDelegateConfig } from "./config.ts";
import { DelegateEngine } from "./engine.ts";
import { HerdrCliGateway, type SpawnProcess } from "./herdr/client.ts";
import { readEventLog } from "./records.ts";

/** Exact session identity emitted by the simulated Herdr agent lifecycle. */
const CHILD_SESSION = { kind: "id", source: "herdr:claude", value: "realistic-claude-session" } as const;

/** Creates a minimal child-process double that emits one stdout payload and exits cleanly. */
function fakeChild(output: string): ChildProcess {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	setImmediate(() => {
		if (output) child.stdout.emit("data", output);
		child.emit("close", 0, null);
	});
	return child as unknown as ChildProcess;
}

/** Builds the raw Herdr agent object used by get, prompt, wait, and snapshot responses. */
function agentRecord(status: "idle" | "done", includeSession: boolean): Record<string, unknown> {
	return {
		name: "worker-realistic",
		agent: "claude",
		agent_status: status,
		pane_id: "w-test:p2",
		workspace_id: "w-test",
		tab_id: "w-test:t1",
		cwd: "/tmp/realistic-project",
		...(includeSession ? { agent_session: CHILD_SESSION } : {}),
	};
}

/** Creates a CLI-bound Herdr scenario with configurable delayed session publication. */
function createScenario(sessionVisibleAfter: number): { spawnProcess: SpawnProcess; calls: string[][]; getAttempts: () => number } {
	const calls: string[][] = [];
	let getAttempts = 0;
	let formalRelaySubmitted = false;
	const spawnProcess: SpawnProcess = (_command, args, _options: SpawnOptions) => {
		calls.push([...args]);
		const [scope, operation] = args;
		if (args[0] === "--version") return fakeChild("herdr 0.8.0\n");
		if (scope === "api" && operation === "snapshot") {
			return fakeChild(JSON.stringify({
				result: {
					snapshot: {
						agents: [{
						name: "parent-realistic",
						agent: "pi",
						agent_status: "idle",
						pane_id: "w-test:p1",
						workspace_id: "w-test",
						agent_session: { kind: "id", source: "herdr:pi", value: "parent-session" },
					}],
					},
				},
			}));
		}
		if (scope === "pane" && operation === "split") {
			return fakeChild(JSON.stringify({ result: { pane: { pane_id: "w-test:p2", workspace_id: "w-test", tab_id: "w-test:t1" } } }));
		}
		if (scope === "agent" && operation === "start") return fakeChild(JSON.stringify({ result: { ok: true } }));
		if (scope === "agent" && operation === "get") {
			getAttempts += 1;
			return fakeChild(JSON.stringify({ result: { agent: agentRecord("idle", getAttempts >= sessionVisibleAfter) } }));
		}
		if (scope === "agent" && operation === "prompt") {
			const text = args[3] ?? "";
			if (text.includes("COMMUNICATION FILE:")) formalRelaySubmitted = true;
			return fakeChild(JSON.stringify({ result: { agent: agentRecord("idle", true) } }));
		}
		if (scope === "agent" && operation === "wait") {
			return fakeChild(JSON.stringify({ result: { agent: agentRecord("done", true) } }));
		}
		if (scope === "agent" && operation === "read") {
			return fakeChild(formalRelaySubmitted ? "STATUS: DONE\nSUMMARY: realistic Claude call completed\nVALIDATION: simulated Herdr CLI path passed\n" : "");
		}
		if (scope === "pane" && operation === "move") {
			return fakeChild(JSON.stringify({ result: { tab: { tab_id: "w-test:t2" } } }));
		}
		return fakeChild(JSON.stringify({ result: { ok: true } }));
	};
	return { spawnProcess, calls, getAttempts: () => getAttempts };
}

/** Creates the production leaf engine with a Claude worker role and isolated event logs. */
async function createRealisticEngine(root: string, spawnProcess: SpawnProcess): Promise<DelegateEngine> {
	const gateway = new HerdrCliGateway({
		command: "herdr-simulated",
		cwd: "/tmp/realistic-project",
		spawnProcess,
		sleep: async () => undefined,
	});
	return new DelegateEngine({
		gateway,
		config: parseDelegateConfig({
			version: 1,
			roles: { worker: { agent: "claude", timeoutMs: 1000, panePolicy: "new-tab" } },
		}),
		communicationDirectory: join(root, "communications"),
		id: () => "realistic",
		sleep: async () => undefined,
	});
}

/** Verifies a real leaf transaction across gateway spawn, delayed session metadata, relay, output, and pane move. */
test("realistic Claude delegate completes through the Herdr CLI boundary", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-realistic-done-"));
	try {
		const scenario = createScenario(2);
		const engine = await createRealisticEngine(root, scenario.spawnProcess);
		const result = await engine.run({ action: "delegate", task: "run a no-side-effect realistic smoke", role: "worker" }, {
			cwd: "/tmp/realistic-project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});

		assert.equal(result.status, "DONE");
		assert.equal(result.agent, "worker-realistic");
		assert.deepEqual(result.agentSession, CHILD_SESSION);
		assert.equal(scenario.getAttempts(), 3);
		assert.equal(scenario.calls.filter(([scope, operation]) => scope === "agent" && operation === "start").length, 1);
		const promptCalls = scenario.calls.filter(([scope, operation]) => scope === "agent" && operation === "prompt");
		assert.equal(promptCalls.length, 2);
		assert.match(promptCalls[0][3] ?? "", /^RY_HERDR_SESSION_BOOTSTRAP:/);
		assert.match(promptCalls[1][3] ?? "", /COMMUNICATION FILE:/);
		assert.equal(scenario.calls.filter(([scope, operation]) => scope === "agent" && operation === "wait").length, 1);
		assert.equal(scenario.calls.filter(([scope, operation]) => scope === "agent" && operation === "read").length, 2);
		assert.deepEqual(scenario.calls.at(-1), ["pane", "move", "w-test:p2", "--new-tab", `--label`, `closed-pane-${result.communicationId}`, "--workspace", "w-test", "--no-focus"]);
		const events = (await readEventLog(result.communicationFile)).events.map(({ event }) => event.type);
		assert.deepEqual(events.slice(-2), ["result", "pane-disposition"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Verifies a real CLI-bound child without exact metadata remains blocked without relay or pane disposition. */
test("realistic Claude delegate fails closed when session metadata never appears", async () => {
	const root = await mkdtemp(join("/tmp", "ry-herdr-realistic-blocked-"));
	try {
		const scenario = createScenario(Number.POSITIVE_INFINITY);
		const engine = await createRealisticEngine(root, scenario.spawnProcess);
		const result = await engine.run({ action: "delegate", task: "run a no-side-effect blocked smoke", role: "worker" }, {
			cwd: "/tmp/realistic-project",
			workspaceId: "w-test",
			sourcePaneId: "w-test:p1",
		});

		assert.equal(result.status, "BLOCKED");
		assert.equal(result.error, "Herdr did not return exact agent_session metadata");
		const promptCalls = scenario.calls.filter(([scope, operation]) => scope === "agent" && operation === "prompt");
		assert.equal(promptCalls.length, 2);
		assert.ok(promptCalls.every((call) => /^RY_HERDR_SESSION_BOOTSTRAP:/.test(call[3] ?? "")));
		assert.equal(scenario.calls.some(([scope, operation]) => scope === "agent" && operation === "read"), false);
		assert.equal(scenario.calls.some(([scope, operation]) => scope === "pane" && operation === "move"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
