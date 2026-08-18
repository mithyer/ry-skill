import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";
import type { HerdrGateway } from "./types.ts";

import {
	createAutomaticDelegateInputHandler,
	createDelegateCommandHandler,
	detectAutomaticDelegateRequest,
	formatDelegateToolResult,
	formatPipelineUi,
	GLOBAL_CONFIG_PATH,
	LEGACY_GLOBAL_CONFIG_PATH,
	registerDelegateTool,
	selectAgentForTask,
	startDirectDelegateUiMonitor,
	type DelegateToolDetails,
	type DelegateToolParams,
} from "./tool.ts";

/** Verifies the extension-local configuration path and legacy migration boundary. */
test("uses the extension-local ry-herdr-agent configuration path", () => {
	assert.equal(GLOBAL_CONFIG_PATH, join(homedir(), ".pi", "agent", "extensions", "ry-skill", "ry-herdr-agent-config.json"));
	assert.equal(LEGACY_GLOBAL_CONFIG_PATH, join(homedir(), ".pi", "agent", "ry-herdr-delegate.json"));
});

/** Builds the smallest UI surface needed by direct command and input-handler tests. */
function makeContext(
	idle = true,
	statusCalls: Array<string | undefined> = [],
	widgetCalls: Array<string[] | undefined> = [],
	notifications: Array<{ text: string; type: string }> = [],
): ExtensionContext {
	return {
		mode: "tui",
		cwd: "/tmp/project",
		signal: undefined,
		isIdle: () => idle,
		ui: {
			notify: (text: string, type: string) => { notifications.push({ text, type }); },
			setWorkingMessage: () => undefined,
			setWorkingVisible: () => undefined,
			setStatus: (_key: string, text: string | undefined) => { statusCalls.push(text); },
			setWidget: (_key: string, lines: string[] | undefined) => { widgetCalls.push(lines); },
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

/** Verifies slash-command task intent selects a child profile instead of the delegate role default. */
test("selectAgentForTask routes explicit, review, engineering, and general tasks", () => {
	assert.equal(selectAgentForTask("用codex，修复分享图生成逻辑"), "codex");
	assert.equal(selectAgentForTask("use Claude to review the requested change"), "claude");
	assert.equal(selectAgentForTask("review the requested change"), "claude");
	assert.equal(selectAgentForTask("修复登录失败并运行测试"), "codex");
	assert.equal(selectAgentForTask("ExerciseDetailsSharedViewControllerV2底部需要和ExerciseHomeViewControllerV2一样，底部要有运动id"), "codex");
	assert.equal(selectAgentForTask("整理一下当前进度"), "pi");
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

/** Verifies automatic Claude routing renders the resolved external child status in the parent UI. */
test("createAutomaticDelegateInputHandler displays the resolved Claude agent status", async () => {
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	const executor = async (): Promise<AgentToolResult<DelegateToolDetails>> => ({
		content: [{ type: "text", text: "DONE" }],
		details: {
			status: "DONE",
			result: {
				status: "DONE",
				communicationId: "communication-claude",
				communicationFile: "/private/communication-claude.jsonl",
				agent: "claude-child",
				paneId: "w-test:p2",
				completion: { status: "DONE", summary: "Claude read-only validation complete" },
			},
		},
	});
	const handler = createAutomaticDelegateInputHandler(executor);
	const result = await handler({ type: "input", text: "请使用 Claude 审查这次修改", source: "interactive" }, makeContext(true, statuses, widgets));
	assert.deepEqual(result, { action: "handled" });
	assert.deepEqual(statuses, ["Herdr delegate · RUNNING · claude", "Herdr delegate · DONE · claude-child", undefined]);
	assert.deepEqual(widgets, [
		["Herdr delegate · RUNNING", "Agent: claude"],
		["Herdr delegate · DONE", "Agent: claude-child", "Pane: w-test:p2", "Summary: Claude read-only validation complete"],
		undefined,
	]);
});

/** Verifies incidental prompts, slash commands, and busy sessions remain available to normal Pi handling. */
test("createAutomaticDelegateInputHandler does not intercept non-direct prompts", async () => {
	const calls: DelegateToolParams[] = [];
	const handler = createAutomaticDelegateInputHandler(makeExecutor(calls));
	const prompts: InputEvent[] = [
		{ type: "input", text: "Codex 和 Claude 有什么区别？", source: "interactive" },
		{ type: "input", text: "不要使用 codex 修复这个问题", source: "interactive" },
		{ type: "input", text: "/ry-herdr-agent 请使用 codex 修复这个问题", source: "interactive" },
		{ type: "input", text: "请使用 codex 修复这个问题", source: "interactive", streamingBehavior: "followUp" },
	];
	for (const event of prompts) assert.deepEqual(await handler(event, makeContext()), { action: "continue" });
	assert.equal(calls.length, 0);
	assert.deepEqual(await handler({ type: "input", text: "请使用 codex 修复这个问题", source: "interactive" }, makeContext(false)), { action: "continue" });
	assert.equal(calls.length, 0);
});

/** Verifies the slash command passes its argument to the delegate leaf instead of showing a status-only notice. */
test("createDelegateCommandHandler executes the supplied task and updates direct status", async () => {
	const calls: DelegateToolParams[] = [];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	const transcript: Array<Record<string, unknown>> = [];
	const handler = createDelegateCommandHandler(makeExecutor(calls), (entry) => transcript.push(entry as unknown as Record<string, unknown>));
	await handler("fix the requested issue", makeContext(true, statuses, widgets) as ExtensionCommandContext);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].action, "delegate");
	assert.equal(calls[0].role, "worker");
	assert.equal(calls[0].agent, "codex");
	assert.equal(calls[0].timeoutMs, 600000);
	assert.equal(calls[0].task, "fix the requested issue");
	assert.deepEqual(statuses, ["Herdr delegate · RUNNING · codex", "Herdr delegate · DONE · codex", undefined]);
	assert.deepEqual(widgets, [["Herdr delegate · RUNNING", "Agent: codex"], ["Herdr delegate · DONE", "Agent: codex"], undefined]);
	assert.deepEqual(transcript, [
		{ kind: "prompt", prompt: "/ry-herdr-agent fix the requested issue" },
		{ kind: "result", status: "DONE", agent: "codex" },
	]);
});

/** Routes source-symbol modification wording through the slash command to the Codex worker profile. */
test("createDelegateCommandHandler routes a ViewController change request to Codex", async () => {
	const calls: DelegateToolParams[] = [];
	const handler = createDelegateCommandHandler(makeExecutor(calls));
	const task = "ExerciseDetailsSharedViewControllerV2底部需要和ExerciseHomeViewControllerV2一样，底部要有运动id";
	await handler(task, makeContext() as ExtensionCommandContext);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].role, "worker");
	assert.equal(calls[0].agent, "codex");
	assert.equal(calls[0].timeoutMs, 600000);
	assert.equal(calls[0].task, task);
});

test("createDelegateCommandHandler gives a Pi fallback task the slash timeout", async () => {
	const calls: DelegateToolParams[] = [];
	const handler = createDelegateCommandHandler(makeExecutor(calls));
	await handler("整理一下当前进度", makeContext() as ExtensionCommandContext);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].role, "delegate");
	assert.equal(calls[0].agent, "pi");
	assert.equal(calls[0].timeoutMs, 600000);
});

test("createDelegateCommandHandler persists the agent conclusion", async () => {
	const transcript: Array<Record<string, unknown>> = [];
	const executor = async (): Promise<AgentToolResult<DelegateToolDetails>> => ({
		content: [{ type: "text", text: "DONE" }],
		details: {
			status: "DONE",
			result: {
				status: "DONE",
				communicationId: "communication-summary",
				communicationFile: "/private/communication-summary.jsonl",
				agent: "worker-summary",
				paneId: "w-test:p4",
				completion: {
					status: "DONE",
					summary: "Added the requested tests",
					validation: "npm test passed",
					changedFiles: "tool.ts and tool.test.ts",
				},
			},
		},
	});
	const handler = createDelegateCommandHandler(executor, (entry) => transcript.push(entry as unknown as Record<string, unknown>));
	await handler("implement and test the requested change", makeContext() as ExtensionCommandContext);
	assert.deepEqual(transcript, [
		{ kind: "prompt", prompt: "/ry-herdr-agent implement and test the requested change" },
		{
			kind: "result",
			status: "DONE",
			agent: "worker-summary",
			summary: "Added the requested tests",
			validation: "npm test passed",
			changedFiles: "tool.ts and tool.test.ts",
		},
	]);
});

/** Verifies an unresolved child displays an animated polling indicator before closure. */
test("direct delegate UI shows a listening spinner while monitoring", async () => {
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	let reads = 0;
	const ctx = makeContext(true, statuses, widgets);
	const gateway = {
		getAgent: async () => {
			reads += 1;
			if (reads === 1) return { paneId: "w-test:p4" };
			throw Object.assign(new Error("agent_not_found"), { code: "agent_not_found" });
		},
	} as unknown as HerdrGateway;
	startDirectDelegateUiMonitor(ctx, gateway, "worker-summary", "w-test:p4", 1, {
		status: "PARTIAL",
		agent: "worker-summary",
		paneId: "w-test:p4",
		summary: "Waiting for explicit continuation",
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	assert.equal(statuses.some((status) => typeof status === "string" && status.includes("LISTENING")), true);
	assert.equal(widgets.some((lines) => lines?.some((line) => line.includes("State: PARTIAL"))), true);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
});

/** Reconciles a late exact completion into a final parent conclusion and clears the lifecycle surface. */
test("direct delegate UI appends a reconciled late completion", async () => {
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	const notifications: Array<{ text: string; type: string }> = [];
	const transcript: Array<Record<string, unknown>> = [];
	const ctx = makeContext(true, statuses, widgets, notifications) as ExtensionCommandContext;
	const gateway = {
		getAgent: async () => ({ agent: "worker-late", paneId: "w-test:p5", workspaceId: "w-test", status: "idle" }),
	} as unknown as HerdrGateway;
	const executor = async (_params: DelegateToolParams, context: ExtensionContext): Promise<AgentToolResult<DelegateToolDetails>> => {
		startDirectDelegateUiMonitor(context, gateway, "worker-late", "w-test:p5", 1, {
			status: "PARTIAL",
			agent: "worker-late",
			paneId: "w-test:p5",
			error: "delegate stage operation was aborted",
		}, async () => ({
			status: "DONE",
			communicationId: "communication-late",
			communicationFile: "/private/communication-late.jsonl",
			agent: "worker-late",
			paneId: "w-test:p5",
			completion: { status: "DONE", summary: "late completion was reconciled", validation: "build passed" },
		}));
		return {
			content: [{ type: "text", text: "PARTIAL" }],
			details: {
				status: "PARTIAL",
				result: {
					status: "PARTIAL",
					communicationId: "communication-late",
					communicationFile: "/private/communication-late.jsonl",
					agent: "worker-late",
					paneId: "w-test:p5",
					error: "delegate stage operation was aborted",
				},
				error: "delegate stage operation was aborted",
			},
		};
	};
	const handler = createDelegateCommandHandler(executor, (entry) => transcript.push(entry as unknown as Record<string, unknown>));
	await handler("implement the requested change", ctx);
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(transcript, [
		{ kind: "prompt", prompt: "/ry-herdr-agent implement the requested change" },
		{ kind: "result", status: "PARTIAL", agent: "worker-late", error: "delegate stage operation was aborted" },
		{ kind: "result", status: "DONE", agent: "worker-late", summary: "late completion was reconciled", validation: "build passed" },
	]);
	assert.equal(notifications.some(({ text, type }) => type === "info" && text.includes("late completion was reconciled")), true);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
});

test("direct delegate UI clears after child closure", async () => {
	const statuses: Array<string | undefined> = ["Herdr delegate · ERROR · codex"];
	const widgets: Array<string[] | undefined> = [["Herdr delegate · ERROR", "Pane: w20:p3"]];
	const ctx = makeContext(true, statuses, widgets);
	const gateway = {
		getAgent: async () => {
			throw Object.assign(new Error("agent_not_found"), { code: "agent_not_found" });
		},
	} as unknown as HerdrGateway;
	startDirectDelegateUiMonitor(ctx, gateway, "worker-c3fe678b-3e5", "w20:p3", 1);
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
});

/** Verifies the extension registers both executable direct-entry surfaces. */
test("registerDelegateTool wires the executable command and input router", () => {
	let toolRegistered = false;
	let renderCallRegistered = false;
	let renderResultRegistered = false;
	let commandName: string | undefined;
	let commandDescription: string | undefined;
	let entryRendererRegistered = false;
	let entryAppended = false;
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
		registerEntryRenderer: () => {
			entryRendererRegistered = true;
		},
		appendEntry: () => {
			entryAppended = true;
		},
		on: (event: string) => {
			if (event === "input") inputRegistered = true;
		},
	} as unknown as ExtensionAPI;
	registerDelegateTool(extensionApi);
	assert.equal(toolRegistered, true);
	assert.equal(renderCallRegistered, true);
	assert.equal(renderResultRegistered, true);
	assert.equal(entryRendererRegistered, true);
	assert.equal(entryAppended, false);
	assert.equal(commandName, "ry-herdr-agent");
	assert.match(commandDescription ?? "", /Execute one Herdr delegate leaf task/);
	assert.equal(inputRegistered, true);
});
