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
	formatDelegateToolResult,
	formatPipelineUi,
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

/** Verifies parent UI formatting exposes pipeline and stage progress without task or child output text. */
test("formatPipelineUi renders coordinator and stage status", () => {
	const lines = formatPipelineUi({
		state: {
			pipelineId: "pipeline-demo",
			communicationFile: "/tmp/pipeline-demo.jsonl",
			status: "RUNNING",
			lastSeq: 9,
			currentStage: "worker",
			summary: "stage is executing",
		},
		stages: [
			{ stageIndex: 0, role: "worker", status: "RUNNING", lastEventSeq: 8, lastOutcomeSeq: 0, agent: "codex", paneId: "w-test:p2" },
			{ stageIndex: 1, role: "reviewer", status: "QUEUED", lastEventSeq: 3, lastOutcomeSeq: 0 },
		],
	});
	assert.deepEqual(lines, [
		"Herdr pipeline pipeline-demo · RUNNING",
		"Current stage: worker",
		"1. worker · RUNNING · codex · pane w-test:p2",
		"2. reviewer · QUEUED",
		"Summary: stage is executing",
	]);
});

/** Verifies tool transcripts expose only actionable identifiers instead of raw JSON paths and sessions. */
test("formatDelegateToolResult hides raw delegation metadata", () => {
	const summary = formatDelegateToolResult({
		status: "QUEUED",
		submission: {
			status: "QUEUED",
			pipelineId: "pipeline-demo",
			communicationFile: "/private/project/pipelines/pipeline-demo.jsonl",
			coordinator: {
				paneId: "w-test:p2",
				agent: "pipeline-coordinator-demo",
				agentSession: { kind: "path", source: "herdr:pi", value: "/private/session.jsonl" },
				workspaceId: "w-test",
			},
		},
	});
	assert.equal(summary, "Pipeline QUEUED: pipeline-demo\nCoordinator pane: w-test:p2");
	assert.doesNotMatch(summary, /communicationFile|agentSession|private|\\{/);
});

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
	let renderCallRegistered = false;
	let renderResultRegistered = false;
	let commandName: string | undefined;
	let commandDescription: string | undefined;
	let inputRegistered = false;
	const extensionApi = {
		registerTool: (definition: { renderCall?: unknown; renderResult?: unknown }) => {
			toolRegistered = true;
			renderCallRegistered = typeof definition.renderCall === "function";
			renderResultRegistered = typeof definition.renderResult === "function";
		},
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
	assert.equal(renderCallRegistered, true);
	assert.equal(renderResultRegistered, true);
	assert.equal(commandName, "ry-herdr-delegate");
	assert.match(commandDescription ?? "", /Execute one Herdr delegate leaf task/);
	assert.equal(inputRegistered, true);
});
