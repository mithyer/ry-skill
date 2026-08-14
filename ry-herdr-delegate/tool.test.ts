import assert from "node:assert/strict";
import test from "node:test";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";

import {
	createAutomaticDelegateInputHandler,
	createDelegateCommandHandler,
	detectAutomaticDelegateRequest,
	registerDelegateTool,
	type DelegateToolDetails,
	type DelegateToolParams,
} from "./tool.ts";

/** Builds the smallest UI surface needed by direct command and input-handler tests. */
function makeContext(idle = true): ExtensionContext {
	return {
		mode: "tui",
		cwd: "/tmp/project",
		signal: undefined,
		isIdle: () => idle,
		ui: {
			notify: () => undefined,
			setWorkingMessage: () => undefined,
			setWorkingVisible: () => undefined,
		},
	} as unknown as ExtensionContext;
}

/** Builds a deterministic successful executor and records every direct request. */
function makeExecutor(calls: DelegateToolParams[]): (params: DelegateToolParams, _ctx: ExtensionContext) => Promise<AgentToolResult<DelegateToolDetails>> {
	return async (params) => {
		calls.push(params);
		return { content: [{ type: "text", text: "DONE" }], details: { status: "DONE" } };
	};
}

/** Verifies explicit Chinese/English agent directives and incidental/negative exclusions. */
test("detectAutomaticDelegateRequest routes actionable Codex and Claude prompts", () => {
	assert.deepEqual(detectAutomaticDelegateRequest("请使用codex修复这个 bug"), {
		agent: "codex",
		task: "请使用codex修复这个 bug",
	});
	assert.deepEqual(detectAutomaticDelegateRequest("Please use Claude to review this change"), {
		agent: "claude",
		task: "Please use Claude to review this change",
	});
	assert.equal(detectAutomaticDelegateRequest("Codex 和 Claude 有什么区别？"), undefined);
	assert.equal(detectAutomaticDelegateRequest("不要使用 codex 修复这个问题"), undefined);
	assert.equal(detectAutomaticDelegateRequest("请介绍一下 Claude"), undefined);
});

/** Verifies automatic input handling directly invokes the selected agent and suppresses the model turn. */
test("createAutomaticDelegateInputHandler executes an actionable prompt", async () => {
	const calls: DelegateToolParams[] = [];
	const handler = createAutomaticDelegateInputHandler(makeExecutor(calls));
	const event: InputEvent = {
		type: "input",
		text: "请使用 Claude 审查这次修改",
		source: "interactive",
	};
	const result = await handler(event, makeContext());
	assert.deepEqual(result, { action: "handled" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].action, "delegate");
	assert.equal(calls[0].agent, "claude");
	assert.equal(calls[0].role, "worker");
	assert.equal(calls[0].task, event.text);
});

/** Verifies incidental prompts, slash commands, and busy sessions remain available to normal Pi handling. */
test("createAutomaticDelegateInputHandler does not intercept non-direct prompts", async () => {
	const calls: DelegateToolParams[] = [];
	const handler = createAutomaticDelegateInputHandler(makeExecutor(calls));
	const prompts: InputEvent[] = [
		{ type: "input", text: "Codex 和 Claude 有什么区别？", source: "interactive" },
		{ type: "input", text: "不要使用 codex 修复这个问题", source: "interactive" },
		{ type: "input", text: "/ry-herdr-delegate 请使用 codex 修复这个问题", source: "interactive" },
		{ type: "input", text: "请使用 codex 修复这个问题", source: "interactive", streamingBehavior: "followUp" },
	];
	for (const event of prompts) assert.deepEqual(await handler(event, makeContext()), { action: "continue" });
	assert.equal(calls.length, 0);
	assert.deepEqual(await handler({ type: "input", text: "请使用 codex 修复这个问题", source: "interactive" }, makeContext(false)), { action: "continue" });
	assert.equal(calls.length, 0);
});

/** Verifies the slash command passes its argument to the delegate leaf instead of showing a status-only notice. */
test("createDelegateCommandHandler executes the supplied task", async () => {
	const calls: DelegateToolParams[] = [];
	const handler = createDelegateCommandHandler(makeExecutor(calls));
	await handler("fix the requested issue", makeContext() as ExtensionCommandContext);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].action, "delegate");
	assert.equal(calls[0].role, "delegate");
	assert.equal(calls[0].task, "fix the requested issue");
});

/** Verifies the extension registers both executable direct-entry surfaces. */
test("registerDelegateTool wires the executable command and input router", () => {
	let toolRegistered = false;
	let commandName: string | undefined;
	let commandDescription: string | undefined;
	let inputRegistered = false;
	const extensionApi = {
		registerTool: () => { toolRegistered = true; },
		registerCommand: (name: string, options: { description?: string }) => {
			commandName = name;
			commandDescription = options.description;
		},
		on: (event: string) => {
			if (event === "input") inputRegistered = true;
		},
	} as unknown as ExtensionAPI;
	registerDelegateTool(extensionApi);
	assert.equal(toolRegistered, true);
	assert.equal(commandName, "ry-herdr-delegate");
	assert.match(commandDescription ?? "", /Execute one Herdr delegate leaf task/);
	assert.equal(inputRegistered, true);
});
