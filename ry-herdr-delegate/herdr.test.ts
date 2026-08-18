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
function fakeChild(output: string, code: number | null = 0, terminationSignal: NodeJS.Signals | null = null, errorOutput = ""): ChildProcess {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	setImmediate(() => {
		if (output) child.stdout.emit("data", output);
		if (errorOutput) child.stderr.emit("data", errorOutput);
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
	const fireAndForget = await gateway.prompt({ target: started.agent, text: "relay-no-wait", wait: false, timeoutMs: 25 });
	assert.equal(fireAndForget?.agentSession?.value, "session-test");
	const output = await gateway.readAgent(started.agent);
	assert.equal(output.text, "terminal output\n");
	await gateway.movePane({
		paneId: started.paneId,
		newTab: true,
		tabLabel: "closed-pane-test",
		workspaceId: "w-test",
		focus: false,
	});

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
	const noWaitPromptCall = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt" && call.args[3] === "relay-no-wait");
	assert.ok(noWaitPromptCall);
	assert.deepEqual(noWaitPromptCall.args, ["agent", "prompt", "worker-test", "relay-no-wait"]);
	const waitCall = calls.find((call) => call.args[0] === "agent" && call.args[1] === "wait");
	assert.ok(waitCall);
	assert.deepEqual(waitCall.args.slice(-6), ["--until", "idle", "--until", "done", "--timeout", "25"]);
	const moveCall = calls.find((call) => call.args[0] === "pane" && call.args[1] === "move");
	assert.ok(moveCall);
	assert.deepEqual(moveCall.args, ["pane", "move", "w-test:p2", "--new-tab", "--label", "closed-pane-test", "--workspace", "w-test", "--no-focus"]);
});

/** Verifies cancellation reaches every Herdr lifecycle subprocess used by a leaf stage. */
test("HerdrCliGateway forwards AbortSignal across lifecycle commands", async () => {
	const calls: SpawnCall[] = [];
	const controller = new AbortController();
	const gateway = makeGateway(calls);
	await gateway.splitPane({ sourcePaneId: "w-test:p1", signal: controller.signal });
	await gateway.startAgent({ name: "worker-signal", kind: "pi", paneId: "w-test:p2", agentArgs: ["--yolo"], signal: controller.signal });
	await gateway.readAgent("worker-signal", controller.signal);
	await gateway.movePane({ paneId: "w-test:p2", newTab: true, tabLabel: "signal-pane", signal: controller.signal });
	await gateway.closePane("w-test:p2", controller.signal);
	for (const call of calls) assert.ok(call.options.signal instanceof AbortSignal, `${call.args[0]} ${call.args[1]} did not receive a cancellable signal`);
});
test("HerdrCliGateway recovers agent_prompt_stalled from current agent metadata", async () => {
	const calls: SpawnCall[] = [];
	const spawnProcess: SpawnProcess = (command, args, options) => {
		calls.push({ command, args: [...args], options });
		if (args[0] === "agent" && args[1] === "prompt") {
			return fakeChild(JSON.stringify({ error: { code: "agent_prompt_stalled", message: "agent prompt produced no observed state change" } }), 1);
		}
		if (args[0] === "agent" && args[1] === "get") return fakeChild(agentResponse());
		return fakeChild(JSON.stringify({ result: { ok: true } }));
	};
	const gateway = new HerdrCliGateway({ command: "herdr-test", cwd: "/tmp/project", spawnProcess });
	const prompted = await gateway.prompt({ target: "worker-test", text: "relay", wait: true, timeoutMs: 25 });
	assert.equal(prompted?.agent, "worker-test");
	assert.equal(prompted?.agentSession?.value, "session-test");
	assert.equal(calls.filter((call) => call.args[0] === "agent" && call.args[1] === "prompt").length, 1);
	assert.equal(calls.filter((call) => call.args[0] === "agent" && call.args[1] === "get").length, 1);
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
/** Verifies a transient Herdr terminal-read race is retried without changing the command boundary. */
test("HerdrCliGateway retries transient agent_not_idle terminal reads", async () => {
	const calls: SpawnCall[] = [];
	const delays: number[] = [];
	let readAttempts = 0;
	const spawnProcess: SpawnProcess = (command, args, options) => {
		calls.push({ command, args: [...args], options });
		if (args[0] === "agent" && args[1] === "read") {
			readAttempts += 1;
			if (readAttempts === 1) {
				return fakeChild("", 1, null, JSON.stringify({ error: { code: "agent_not_idle", message: "agent output is only readable while idle" } }));
			}
			return fakeChild("STATUS: DONE\nSUMMARY: refreshed terminal\nVALIDATION: read retry passed\n");
		}
		return fakeChild(JSON.stringify({ result: { ok: true } }));
	};
	const gateway = new HerdrCliGateway({
		command: "herdr-test",
		cwd: "/tmp/project",
		spawnProcess,
		sleep: async (milliseconds) => { delays.push(milliseconds); },
	});

	const output = await gateway.readAgent("worker-test");

	assert.match(output.text, /SUMMARY: refreshed terminal/);
	assert.equal(readAttempts, 2);
	assert.deepEqual(delays, [100]);
	assert.equal(calls.filter((call) => call.args[0] === "agent" && call.args[1] === "read").length, 2);
});

/** Verifies startup establishes a missing external session before the real relay can be sent. */
test("HerdrCliGateway bootstraps delayed agent_session metadata", async () => {
	const calls: SpawnCall[] = [];
	let getAttempts = 0;
	const spawnProcess: SpawnProcess = (command, args, options) => {
		calls.push({ command, args: [...args], options });
		if (args[0] === "agent" && args[1] === "get") {
			getAttempts += 1;
			return fakeChild(JSON.stringify({
				result: {
					agent: {
						name: "worker-test",
						agent: "codex",
						agent_status: "idle",
						pane_id: "w-test:p2",
						workspace_id: "w-test",
						tab_id: "w-test:t1",
						cwd: "/tmp/project",
						...(getAttempts > 1 ? { agent_session: { kind: "id", source: "herdr:codex", value: "bootstrapped-session" } } : {}),
					},
				},
			}));
		}
		if (args[0] === "agent" && args[1] === "prompt") {
			return fakeChild(JSON.stringify({ result: { agent: { ...JSON.parse(agentResponse()).result.agent, agent: "codex", agent_session: { kind: "id", source: "herdr:codex", value: "bootstrapped-session" } } } }));
		}
		return fakeChild(JSON.stringify({ result: { ok: true } }));
	};
	const gateway = new HerdrCliGateway({
		command: "herdr-test",
		cwd: "/tmp/project",
		spawnProcess,
		sleep: async () => undefined,
	});
	const started = await gateway.startAgent({ name: "worker-test", kind: "codex", paneId: "w-test:p2", agentArgs: ["--yolo"] });
	assert.equal(started.agentSession?.value, "bootstrapped-session");
	assert.equal(getAttempts, 2);
	const bootstrapCall = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt");
	assert.ok(bootstrapCall);
	assert.match(String(bootstrapCall.args[3]), /^RY_HERDR_SESSION_BOOTSTRAP:/);
	assert.deepEqual(bootstrapCall.args.slice(-3), ["--wait", "--timeout", "10000"]);
});
/** Reports command failures with captured evidence. */
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
	await assert.rejects(gateway.getAgent("worker-test"), (error: unknown) => error instanceof HerdrCommandError && /timeout after 5ms/.test(error.message) && error.timedOut === true);
	assert.equal(aborted, true);
});
