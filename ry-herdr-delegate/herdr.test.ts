import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test from "node:test";

import { HerdrCliGateway, HerdrCommandError, type SpawnProcess } from "./herdr/client.ts";

/** Captured process invocation used to verify the gateway execution boundary. */
interface SpawnCall {
	/** Executable passed to spawn. */
	command: string;
	/** Argument vector passed to spawn. */
	args: readonly string[];
	/** Spawn options passed to the child process. */
	options: SpawnOptions;
}

/** Creates a minimal child-process double that emits output and close events. */
function fakeChild(output: string, code: number | null = 0, terminationSignal: NodeJS.Signals | null = null): ChildProcess {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	setImmediate(() => {
		if (output) child.stdout.emit("data", output);
		child.emit("close", code, terminationSignal);
	});
	return child as unknown as ChildProcess;
}

/** Returns the normalized agent response used by command-shape tests. */
function agentResponse(): string {
	return JSON.stringify({
		result: {
			agent: {
				name: "worker-test",
				agent: "codex",
				agent_status: "idle",
				pane_id: "w-test:p2",
				workspace_id: "w-test",
				tab_id: "w-test:t1",
				cwd: "/tmp/project",
				agent_session: { kind: "id", source: "herdr", value: "session-test" },
			},
		},
	});
}

/** Creates a gateway fake whose JSON responses follow the Herdr CLI command. */
function makeGateway(calls: SpawnCall[]): HerdrCliGateway {
	const spawnProcess: SpawnProcess = (command, args, options) => {
		calls.push({ command, args: [...args], options });
		if (args[0] === "agent" && args[1] === "read") return fakeChild("terminal output\n");
		if (args[0] === "agent" && (args[1] === "get" || args[1] === "prompt" || args[1] === "wait")) return fakeChild(agentResponse());
		if (args[0] === "pane" && args[1] === "split") return fakeChild(JSON.stringify({ result: { pane: { pane_id: "w-test:p2", workspace_id: "w-test", tab_id: "w-test:t1" } } }));
		return fakeChild(JSON.stringify({ result: { ok: true } }));
	};
	return new HerdrCliGateway({
		command: "herdr-test",
		cwd: "/tmp/herdr-root",
		env: { RY_GATEWAY_TEST: "yes" },
		spawnProcess,
	});
}

/** Verifies the Herdr version and snapshot JSON contract before runtime use. */
test("HerdrCliGateway probes Herdr capabilities once", async () => {
	const calls: SpawnCall[] = [];
	const spawnProcess: SpawnProcess = (command, args, options) => {
		calls.push({ command, args: [...args], options });
		if (args[0] === "--version") return fakeChild("herdr 0.8.0\n");
		return fakeChild(JSON.stringify({ result: { snapshot: { agents: [{ agent: "worker-test", agent_status: "idle", pane_id: "w-test:p2", workspace_id: "w-test", agent_session: { kind: "id", source: "herdr", value: "session-test" } }] } } }));
	};
	const gateway = new HerdrCliGateway({ command: "herdr-test", cwd: "/tmp/project", spawnProcess });
	const first = await gateway.probe();
	const second = await gateway.probe();
	assert.deepEqual(first, { herdrVersion: "0.8.0", jsonSnapshot: true });
	assert.deepEqual(second, first);
	assert.deepEqual(calls.map((call) => call.args), [["--version"], ["api", "snapshot"]]);
});

/** Rejects malformed capability output before any Herdr side-effect command. */
test("HerdrCliGateway rejects malformed capability probe output", async () => {
	const spawnProcess: SpawnProcess = (_command, args, options) => fakeChild(args[0] === "--version" ? "herdr 0.8.0\n" : JSON.stringify({ result: {} }));
	const gateway = new HerdrCliGateway({ command: "herdr-test", cwd: "/tmp/project", spawnProcess });
	await assert.rejects(gateway.probe(), /snapshot JSON shape is invalid/);
});


test("HerdrCliGateway uses the validated spawn boundary", async () => {
	const calls: SpawnCall[] = [];
	const gateway = makeGateway(calls);
	const pane = await gateway.splitPane({
		sourcePaneId: "w-test:p1",
		direction: "right",
		cwd: "/tmp/project",
		env: { STAGE_VALUE: "one" },
		focus: false,
	});
	assert.equal(pane.paneId, "w-test:p2");
	const started = await gateway.startAgent({ name: "worker-test", kind: "codex", paneId: pane.paneId, agentArgs: ["--yolo"] });
	assert.equal(started.agent, "worker-test");
	assert.equal(started.agentSession?.value, "session-test");
	const prompted = await gateway.prompt({ target: started.agent, text: "relay", wait: true, timeoutMs: 25 });
	assert.equal(prompted?.paneId, "w-test:p2");
	const waited = await gateway.waitFor({ target: started.agent, until: ["idle", "done"], timeoutMs: 25 });
	assert.equal(waited.agentSession?.value, "session-test");
	const output = await gateway.readAgent(started.agent);
	assert.equal(output.text, "terminal output\n");

	const splitCall = calls[0];
	assert.equal(splitCall.command, "herdr-test");
	assert.deepEqual(splitCall.args, ["pane", "split", "--pane", "w-test:p1", "--direction", "right", "--cwd", "/tmp/project", "--env", "STAGE_VALUE=one", "--no-focus"]);
	assert.equal(splitCall.options.cwd, "/tmp/herdr-root");
	assert.equal(splitCall.options.shell, false);
	assert.equal((splitCall.options.env as NodeJS.ProcessEnv).RY_GATEWAY_TEST, "yes");
	const startCall = calls.find((call) => call.args[0] === "agent" && call.args[1] === "start");
	assert.ok(startCall);
	assert.deepEqual(startCall.args.slice(-2), ["--", "--yolo"]);
	const promptCall = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt");
	assert.ok(promptCall);
	assert.deepEqual(promptCall.args.slice(0, 3), ["agent", "prompt", "worker-test"]);
	assert.deepEqual(promptCall.args.slice(-4), ["relay", "--wait", "--timeout", "25"]);
	const waitCall = calls.find((call) => call.args[0] === "agent" && call.args[1] === "wait");
	assert.ok(waitCall);
	assert.deepEqual(waitCall.args.slice(-6), ["--until", "idle", "--until", "done", "--timeout", "25"]);
});

/** Checks a newly split shell retries only Herdr's explicit transient pane-busy startup result. */
test("HerdrCliGateway retries transient agent_pane_busy startup", async () => {
	const calls: SpawnCall[] = [];
	const delays: number[] = [];
	let startAttempts = 0;
	const spawnProcess: SpawnProcess = (command, args, options) => {
		calls.push({ command, args: [...args], options });
		if (args[0] === "agent" && args[1] === "start") {
			startAttempts += 1;
			if (startAttempts === 1) {
				return fakeChild(JSON.stringify({ error: { code: "agent_pane_busy", message: "agent target pane w-test:p2 is not an available shell" } }), 1);
			}
			return fakeChild(JSON.stringify({ result: { ok: true } }));
		}
		if (args[0] === "agent" && args[1] === "get") return fakeChild(agentResponse());
		return fakeChild(JSON.stringify({ result: { ok: true } }));
	};
	const gateway = new HerdrCliGateway({
		command: "herdr-test",
		cwd: "/tmp/project",
		spawnProcess,
		sleep: async (milliseconds) => { delays.push(milliseconds); },
	});
	const started = await gateway.startAgent({ name: "worker-test", kind: "pi", paneId: "w-test:p2", agentArgs: ["--thinking", "low"] });
	assert.equal(started.agent, "worker-test");
	assert.equal(startAttempts, 2);
	assert.deepEqual(delays, [100]);
	assert.equal(calls.filter((call) => call.args[0] === "agent" && call.args[1] === "start").length, 2);
});

test("HerdrCliGateway reports command failures with captured evidence", async () => {
	const spawnProcess: SpawnProcess = (_command, _args, _options) => fakeChild("", 7, "SIGTERM");
	const gateway = new HerdrCliGateway({ cwd: "/tmp/project", spawnProcess });
	await assert.rejects(
		gateway.getAgent("worker-test"),
		(error: unknown) => error instanceof HerdrCommandError && error.code === 7 && error.signal === "SIGTERM",
	);
});

/** Checks the gateway timeout aborts the child and preserves structured timeout evidence. */
test("HerdrCliGateway reports command timeouts", async () => {
	let aborted = false;
	const spawnProcess: SpawnProcess = (_command, _args, options) => {
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		const signal = options.signal as AbortSignal;
		signal.addEventListener("abort", () => {
			aborted = true;
			setImmediate(() => child.emit("error", signal.reason));
		});
		return child as unknown as ChildProcess;
	};
	const gateway = new HerdrCliGateway({ cwd: "/tmp/project", timeoutMs: 5, spawnProcess });
	await assert.rejects(gateway.getAgent("worker-test"), (error: unknown) => error instanceof HerdrCommandError && /timeout after 5ms/.test(error.message));
	assert.equal(aborted, true);
});
