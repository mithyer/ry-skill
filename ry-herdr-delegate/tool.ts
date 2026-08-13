import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { createDebugLogger, debug, debugError, withDebugLogger } from "./debug.ts";
import { DelegateEngine } from "./engine.ts";
import { parseDelegateConfig } from "./config.ts";
import { HerdrCliGateway } from "./herdr/client.ts";
import { PipelineCoordinator } from "./pipeline-coordinator.ts";
import { PipelineStore } from "./pipeline.ts";
import type { DelegateResult, PipelineControlResult, PipelineSubmission, SessionIdentity } from "./types.ts";

/** Structured action names exposed by the project-owned runtime. */
const ACTIONS = ["delegate", "pipeline", "pipeline.status", "pipeline.answer", "pipeline.stop", "pipeline.coordinator", "recover"] as const;

/** TypeBox schema for the high-level delegate tool. */
const panePolicy = Type.Optional(Type.Union([Type.Literal("close"), Type.Literal("keep"), Type.Literal("new-tab")]));
const pipelineStage = Type.Object({
	role: Type.String({ minLength: 1 }),
	task: Type.Optional(Type.String({ minLength: 1 })),
	agent: Type.Optional(Type.Union([Type.Literal("codex"), Type.Literal("claude"), Type.Literal("pi")])),
	effort: Type.Optional(Type.String({ minLength: 1 })),
	extraArgs: Type.Optional(Type.Array(Type.String())),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	panePolicy,
});
export const DelegateToolParameters = Type.Object({
	action: Type.Union(ACTIONS.map((action) => Type.Literal(action))),
	task: Type.Optional(Type.String({ minLength: 1 })),
	role: Type.Optional(Type.String({ minLength: 1 })),
	agent: Type.Optional(Type.Union([Type.Literal("codex"), Type.Literal("claude"), Type.Literal("pi")])),
	effort: Type.Optional(Type.String({ minLength: 1 })),
	extraArgs: Type.Optional(Type.Array(Type.String())),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	panePolicy,
	stages: Type.Optional(Type.Array(pipelineStage, { maxItems: 12 })),
	pipelineId: Type.Optional(Type.String({ minLength: 1 })),
	answer: Type.Optional(Type.String()),
});

/** Inferred structured tool parameters. */
export type DelegateToolParams = Static<typeof DelegateToolParameters>;

/** Result details returned to Pi's tool renderer and transcript. */
export interface DelegateToolDetails {
	/** Leaf, pipeline, or explicit capability status. */
	status: string;
	/** Structured engine result when a leaf ran. */
	result?: DelegateResult;
	/** Structured pipeline submission when a pipeline was queued. */
	submission?: PipelineSubmission;
	/** Durable control result for pipeline answer/stop/coordinator actions. */
	control?: PipelineControlResult;
	/** Durable pipeline state for status queries. */
	pipelineState?: unknown;
	/** Stable communication file when available. */
	communicationFile?: string;
	/** Human-readable error or unsupported-action explanation. */
	error?: string;
}

/** Global configuration path used by the extension and debug context. */
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "ry-herdr-delegate.json");

/** Reads the optional global configuration without creating or mutating it. */
async function loadGlobalConfig(): Promise<ReturnType<typeof parseDelegateConfig>> {
	const path = GLOBAL_CONFIG_PATH;
	try {
		return parseDelegateConfig(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return parseDelegateConfig({ version: 1 });
		}
		throw new Error(`Unable to load ry-herdr-delegate configuration: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Formats a result into Pi's text content while retaining structured details. */
function toolResult(details: DelegateToolDetails, isError = false): AgentToolResult<DelegateToolDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

/** Returns the exact current Pi session identity for coordinator-only actions. */
function currentPiSession(ctx: ExtensionContext): SessionIdentity | undefined {
	const value = ctx.sessionManager.getSessionFile();
	return value ? { kind: "path", source: "herdr:pi", value } : undefined;
}

/** Creates the common current-context gateway and coordinator stores. */
function createPipelineCoordinator(ctx: ExtensionContext, config: ReturnType<typeof parseDelegateConfig>, workspaceId: string): PipelineCoordinator {
	return new PipelineCoordinator({
		gateway: new HerdrCliGateway({ cwd: ctx.cwd }),
		config,
		pipelineStore: new PipelineStore(ctx.cwd, workspaceId),
		capabilities: { childEnvVerified: false },
	});
}

/** Executes the currently implemented leaf or pipeline actions. */
export async function executeDelegateTool(
	params: DelegateToolParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<DelegateToolDetails>> {
	const config = await loadGlobalConfig();
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	const paneId = process.env.HERDR_PANE_ID;
	const piSession = currentPiSession(ctx);
	const logger = await createDebugLogger({
		config: config.debug,
		cwd: ctx.cwd,
		projectRoot: ctx.cwd,
		workspaceId,
		paneId,
		piSession,
		configFile: GLOBAL_CONFIG_PATH,
	});
	return withDebugLogger(logger, async () => {
		await debug.log("tool.request.start", {
			action: params.action,
			cwd: params.cwd ?? ctx.cwd,
			workspaceId,
			paneId,
			piSession,
			pipelineId: params.pipelineId,
			task: { length: params.task?.length ?? 0, present: params.task !== undefined },
			stageCount: params.stages?.length,
		});
		try {
			const result = await executeDelegateToolWithConfig(params, ctx, signal, config);
			await debug.log("tool.request.result", { action: params.action, status: result.details?.status, communicationFile: result.details?.communicationFile });
			return result;
		} catch (error) {
			await debug.log("tool.request.error", { action: params.action, error: debugError(error) });
			throw error;
		}
	});
}

/** Executes one request after configuration and the request-scoped logger are initialized. */
async function executeDelegateToolWithConfig(
	params: DelegateToolParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	config: ReturnType<typeof parseDelegateConfig>,
): Promise<AgentToolResult<DelegateToolDetails>> {
	if (params.action === "pipeline") {
		if (!params.task) return toolResult({ status: "ERROR", error: "pipeline requires task" }, true);
		if (ctx.mode !== "tui") return toolResult({ status: "BLOCKED", error: "pipeline requires a Pi TUI context with a Herdr pane" }, true);
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		const sourcePaneId = process.env.HERDR_PANE_ID;
		const callerSession = currentPiSession(ctx);
		if (!workspaceId || !sourcePaneId || !callerSession) return toolResult({ status: "BLOCKED", error: "Pipeline submission requires an exact Herdr pane and Pi session" }, true);
		const coordinator = createPipelineCoordinator(ctx, config, workspaceId);
		try {
			const submission = await coordinator.submit({
				task: params.task,
				panePolicy: params.panePolicy,
				context: { role: params.role, agent: params.agent, effort: params.effort, extraArgs: params.extraArgs, cwd: params.cwd, timeoutMs: params.timeoutMs },
				stages: params.stages,
			}, ctx.cwd, workspaceId, sourcePaneId, params.cwd ?? ctx.cwd, signal, callerSession);
			return toolResult({ status: submission.status, submission, communicationFile: submission.communicationFile });
		} catch (error) {
			return toolResult({ status: "ERROR", error: error instanceof Error ? error.message : String(error) }, true);
		}
	}
	if (params.action === "pipeline.status") {
		if (!params.pipelineId) return toolResult({ status: "ERROR", error: "pipeline.status requires pipelineId" }, true);
		if (!ctx.mode) return toolResult({ status: "BLOCKED", error: "pipeline.status requires a Pi context" }, true);
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		if (!workspaceId) return toolResult({ status: "BLOCKED", error: "Current Pi context has no Herdr workspace" }, true);
		try {
			const state = await createPipelineCoordinator(ctx, config, workspaceId).status(params.pipelineId);
			return toolResult({ status: state.status, pipelineState: state, communicationFile: state.communicationFile });
		} catch (error) {
			return toolResult({ status: "ERROR", error: error instanceof Error ? error.message : String(error) }, true);
		}
	}
	if (params.action === "pipeline.answer") {
		if (!params.pipelineId) return toolResult({ status: "ERROR", error: "pipeline.answer requires pipelineId" }, true);
		if (params.answer === undefined || !params.answer.trim()) return toolResult({ status: "ERROR", error: "pipeline.answer requires a non-empty answer" }, true);
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		if (!workspaceId) return toolResult({ status: "BLOCKED", error: "Current Pi context has no Herdr workspace" }, true);
		try {
			const control = await createPipelineCoordinator(ctx, config, workspaceId).answer(params.pipelineId, params.answer, ctx.cwd, workspaceId, signal);
			return toolResult({ status: control.status, control, communicationFile: control.communicationFile }, control.status === "ERROR");
		} catch (error) {
			return toolResult({ status: "ERROR", error: error instanceof Error ? error.message : String(error) }, true);
		}
	}
	if (params.action === "pipeline.stop") {
		if (!params.pipelineId) return toolResult({ status: "ERROR", error: "pipeline.stop requires pipelineId" }, true);
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		if (!workspaceId) return toolResult({ status: "BLOCKED", error: "Current Pi context has no Herdr workspace" }, true);
		try {
			const control = await createPipelineCoordinator(ctx, config, workspaceId).stop(params.pipelineId, ctx.cwd, workspaceId, signal);
			return toolResult({ status: control.status, control, communicationFile: control.communicationFile }, control.status === "ERROR");
		} catch (error) {
			return toolResult({ status: "ERROR", error: error instanceof Error ? error.message : String(error) }, true);
		}
	}
	if (params.action === "pipeline.coordinator") {
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		const paneId = process.env.HERDR_PANE_ID;
		const session = currentPiSession(ctx);
		if (!workspaceId || !paneId || !session) return toolResult({ status: "BLOCKED", error: "pipeline.coordinator requires an exact Herdr pane and Pi session" }, true);
		try {
			const control = await createPipelineCoordinator(ctx, config, workspaceId).tickCurrent(ctx.cwd, workspaceId, paneId, { ...session, source: "herdr:pi" }, signal);
			return toolResult({ status: control.status, control, communicationFile: control.communicationFile }, control.status === "ERROR");
		} catch (error) {
			return toolResult({ status: "BLOCKED", error: error instanceof Error ? error.message : String(error) }, true);
		}
	}
	if (params.action === "recover") {
		if (!params.pipelineId) return toolResult({ status: "ERROR", error: "recover requires pipelineId" }, true);
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		const sourcePaneId = process.env.HERDR_PANE_ID;
		if (!workspaceId || !sourcePaneId) return toolResult({ status: "BLOCKED", error: "Pi is not running inside a Herdr-managed pane" }, true);
		try {
			const control = await createPipelineCoordinator(ctx, config, workspaceId).recover(params.pipelineId, ctx.cwd, workspaceId, sourcePaneId, ctx.cwd, signal);
			return toolResult({ status: control.status, control, communicationFile: control.communicationFile }, ["ERROR", "BLOCKED", "PARTIAL"].includes(control.status));
		} catch (error) {
			return toolResult({ status: "ERROR", error: error instanceof Error ? error.message : String(error) }, true);
		}
	}

	if (!params.task) return toolResult({ status: "ERROR", error: "delegate requires task" }, true);
	if (ctx.mode !== "tui") return toolResult({ status: "BLOCKED", error: "delegate requires a Pi TUI context with a Herdr pane" }, true);
	const gateway = new HerdrCliGateway({ cwd: ctx.cwd });
	const engine = new DelegateEngine({
		gateway,
		config,
		capabilities: { childEnvVerified: false },
	});
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	const sourcePaneId = process.env.HERDR_PANE_ID;
	if (!workspaceId || !sourcePaneId) {
		return toolResult({ status: "BLOCKED", error: "Pi is not running inside a Herdr-managed pane" }, true);
	}
	const result = await engine.run({
		action: "delegate",
		task: params.task,
		role: params.role ?? "delegate",
		overrides: {
			agent: params.agent,
			effort: params.effort,
			extraArgs: params.extraArgs,
			cwd: params.cwd,
			timeoutMs: params.timeoutMs,
			panePolicy: params.panePolicy,
		},
	}, {
		cwd: params.cwd ?? ctx.cwd,
		workspaceId,
		sourcePaneId,
	}, signal);
	return toolResult({ status: result.status, result, communicationFile: result.communicationFile }, result.status === "ERROR");
}

/** Registers the structured tool and a small command alias for manual inspection. */
export function registerDelegateTool(pi: ExtensionAPI): void {
	const definition: ToolDefinition<typeof DelegateToolParameters, DelegateToolDetails> = {
		name: "ry_herdr_delegate_tool",
		label: "Herdr Delegate",
		description: "Run one structured leaf or pipeline action through the project-owned Herdr gateway.",
		promptSnippet: "Use the structured Herdr delegate runtime for leaf or pipeline work",
		promptGuidelines: ["Use action=delegate for one leaf stage, action=pipeline for non-blocking submission, pipeline.status for replayed state, pipeline.answer or pipeline.stop for durable control, and pipeline.coordinator only from the exact coordinator pane/session."],
		parameters: DelegateToolParameters,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => executeDelegateTool(params, ctx, signal),
	};
	pi.registerTool(definition);
	pi.registerCommand("ry-herdr-delegate", {
		description: "Show the structured Herdr delegate runtime status",
		handler: async (_args, ctx) => {
			ctx.ui.notify("ry_herdr_delegate_tool: leaf, pipeline, and exact JSONL recovery actions are enabled; live smoke remains an explicit validation step", "info");
		},
	});
}
