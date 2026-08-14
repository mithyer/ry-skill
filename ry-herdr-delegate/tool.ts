import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { createDebugLogger, debug, debugError, withDebugLogger } from "./debug.ts";
import { DelegateEngine } from "./engine.ts";
import { parseDelegateConfig } from "./config.ts";
import { HerdrCliGateway } from "./herdr/client.ts";
import { PipelineCoordinator } from "./pipeline-coordinator.ts";
import { PipelineStore, type PipelineProgress } from "./pipeline.ts";
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

/** Inferred structured tool parameters with an explicit action union for direct construction. */
export type DelegateToolParams = Omit<Static<typeof DelegateToolParameters>, "action"> & {
	action: typeof ACTIONS[number];
};

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

/** Agents that can be selected by an explicit natural-language delegation directive. */
export type AutomaticDelegateAgent = "codex" | "claude";

/** Parsed direct-delegation request from an actionable user prompt. */
export interface AutomaticDelegateRequest {
	/** External agent explicitly selected by the user. */
	agent: AutomaticDelegateAgent;
	/** Original prompt preserved as the child task. */
	task: string;
}

/** Explicit verbs that distinguish a delegation request from an incidental agent mention. */
const AUTOMATIC_AGENT_DIRECTIVE = /(?:使用|用|调用|交给|让|请(?:使用|用|调用|让)?|use|using|ask|have|let)\s*(?:agent\s*)?(codex|claude)\b/iu;

/** Negative directives must never be converted into an external-agent execution. */
const AUTOMATIC_AGENT_NEGATION = /(?:不要|不用|不使用|无需|without|don't|do not|not)\s*(?:使用|用|调用|use|using)?\s*(?:agent\s*)?(codex|claude)\b/iu;

/** Minimal work-intent vocabulary required before automatic routing is allowed. */
const AUTOMATIC_WORK_INTENT = /(?:帮我|帮忙|处理|解决|修复|实现|修改|编写|重构|排查|调试|审查|评审|研究|调查|执行|运行|测试|部署|查看|检查|fix|implement|change|write|refactor|debug|review|research|investigate|execute|run|test|build|deploy|check|inspect)/iu;

/**
 * Detects an explicit Codex/Claude work directive without treating incidental mentions as execution requests.
 * @param text Raw user prompt received before the agent loop.
 * @returns The selected agent and original task, or undefined when no direct route is safe.
 * TEST:ry-herdr-delegate/tool.test.ts[detectAutomaticDelegateRequest]
 */
export function detectAutomaticDelegateRequest(text: string): AutomaticDelegateRequest | undefined {
	const task = text.trim();
	if (!task || task.startsWith("/") || AUTOMATIC_AGENT_NEGATION.test(task) || !AUTOMATIC_WORK_INTENT.test(task)) return undefined;
	const match = task.match(AUTOMATIC_AGENT_DIRECTIVE);
	const agent = match?.[1]?.toLowerCase();
	if (agent !== "codex" && agent !== "claude") return undefined;
	return { agent, task };
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

/** Formats structured tool details into a compact transcript-safe summary. */
export function formatDelegateToolResult(details: DelegateToolDetails): string {
	const lines: string[] = [];
	if (details.submission) {
		lines.push(`Pipeline ${details.submission.status}: ${details.submission.pipelineId}`);
		lines.push(`Coordinator pane: ${details.submission.coordinator.paneId}`);
	}
	if (details.control) {
		lines.push(`Pipeline ${details.control.status}: ${details.control.pipelineId ?? "current"}`);
		if (details.control.stagesProcessed !== undefined) lines.push(`Stages processed: ${details.control.stagesProcessed}`);
		if (details.control.currentStage) lines.push(`Current stage: ${details.control.currentStage}`);
	}
	if (details.pipelineState && typeof details.pipelineState === "object") {
		const state = details.pipelineState as { pipelineId?: unknown; status?: unknown; currentStage?: unknown; summary?: unknown };
		if (typeof state.pipelineId === "string" && typeof state.status === "string") {
			lines.push(`Pipeline ${state.status}: ${state.pipelineId}`);
			if (typeof state.currentStage === "string") lines.push(`Current stage: ${state.currentStage}`);
			if (typeof state.summary === "string") lines.push(`Summary: ${state.summary}`);
		}
	}
	if (details.result) {
		lines.push(`Delegate ${details.result.status}: ${details.result.communicationId}`);
		if (details.result.agent) lines.push(`Agent: ${details.result.agent}`);
		if (details.result.paneId) lines.push(`Pane: ${details.result.paneId}`);
		if (details.result.completion?.summary) lines.push(`Summary: ${details.result.completion.summary}`);
	}
	if (details.error) lines.push(`Error: ${details.error}`);
	if (lines.length === 0) lines.push(`Herdr delegate: ${details.status}`);
	return lines.join("\n");
}

/** Minimal structural renderer contract accepted by Pi's custom tool slots. */
interface DelegateRenderComponent {
	/** Renders the component for the current terminal width. */
	render(width: number): string[];
	/** Invalidates component-local rendering caches. */
	invalidate(): void;
}

/** Minimal Pi component used to render one compact styled tool row without importing pi-tui at runtime. */
class DelegateTextComponent implements DelegateRenderComponent {
	/** Styled one-line output retained between Pi render passes. */
	private readonly text: string;

	/** Creates a stable one-line component for the tool renderer. */
	constructor(text: string) {
		this.text = text;
	}

	/** Returns the styled row independently of the available terminal width. */
	render(_width: number): string[] {
		return [this.text];
	}

	/** Invalidates no caches because the component owns immutable text. */
	invalidate(): void {
		return;
	}
}

/** Formats the tool call header without exposing task text or structured arguments. */
function formatDelegateToolCall(args: Partial<DelegateToolParams>, theme: Theme): DelegateRenderComponent {
	return new DelegateTextComponent(theme.fg("toolTitle", `Herdr Delegate · ${args.action ?? "request"}`));
}

/** Renders the compact result row while the full state remains in details and JSONL. */
function renderDelegateToolResult(
	result: AgentToolResult<DelegateToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): DelegateRenderComponent {
	if (options.isPartial) return new DelegateTextComponent(theme.fg("warning", "Herdr Delegate · working..."));
	const summary = formatDelegateToolResult(result.details ?? { status: "UNKNOWN" });
	const color = isError ? "error" : result.details?.status === "DONE" ? "success" : "accent";
	return new DelegateTextComponent(theme.fg(color, summary));
}

/** Formats a result into compact Pi text while retaining structured details for runtime consumers. */
function toolResult(details: DelegateToolDetails, isError = false): AgentToolResult<DelegateToolDetails> {
	return {
		content: [{ type: "text", text: formatDelegateToolResult(details) }],
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

/** Footer key used by the parent Pi session for one active pipeline monitor. */
const PIPELINE_UI_STATUS_KEY = "ry-herdr-delegate";

/** Widget key used by the parent Pi session for detailed pipeline stage progress. */
const PIPELINE_UI_WIDGET_KEY = "ry-herdr-delegate-pipeline";

/** Poll interval for replaying durable pipeline progress into the parent UI. */
const PIPELINE_UI_POLL_MS = 1000;

/** Terminal states that stop the parent-side UI monitor while leaving the final view visible. */
const TERMINAL_PIPELINE_STATUSES = new Set(["DONE", "ERROR", "PARTIAL", "STOPPED"]);

/** Active parent-side pipeline monitors keyed by Pi session and pipeline identity. */
const pipelineUiMonitors = new Map<string, { timer: ReturnType<typeof setInterval>; polling: boolean }>();

/** Formats durable pipeline progress for the footer and editor widget without exposing task text. */
export function formatPipelineUi(progress: Pick<PipelineProgress, "state" | "stages">): string[] {
	const lines = [`Herdr pipeline ${progress.state.pipelineId} · ${progress.state.status}`];
	if (progress.state.currentStage) lines.push(`Current stage: ${progress.state.currentStage}`);
	for (const stage of progress.stages) {
		const details = [stage.status, stage.agent, stage.paneId ? `pane ${stage.paneId}` : undefined].filter((value): value is string => Boolean(value));
		lines.push(`${stage.stageIndex + 1}. ${stage.role} · ${details.join(" · ")}`);
	}
	if (progress.state.summary) lines.push(`Summary: ${progress.state.summary}`);
	return lines;
}

/** Pushes one replayed pipeline snapshot into Pi's footer and widget surfaces. */
function renderPipelineUi(ctx: ExtensionContext, progress: PipelineProgress): void {
	const status = progress.state.status;
	ctx.ui.setStatus(PIPELINE_UI_STATUS_KEY, `pipeline ${progress.state.pipelineId} · ${status}`);
	ctx.ui.setWidget(PIPELINE_UI_WIDGET_KEY, formatPipelineUi(progress));
}

/** Builds a stable monitor key that prevents duplicate timers for one parent pipeline. */
function pipelineUiMonitorKey(ctx: ExtensionContext, pipelineId: string): string {
	return `${ctx.cwd}:${ctx.sessionManager.getSessionFile() ?? "ephemeral"}:${pipelineId}`;
}

/** Stops one parent-side pipeline monitor without clearing its final UI snapshot. */
function stopPipelineUiMonitor(key: string): void {
	const monitor = pipelineUiMonitors.get(key);
	if (!monitor) return;
	clearInterval(monitor.timer);
	pipelineUiMonitors.delete(key);
}

/** Starts non-blocking JSONL polling so the parent Pi UI reflects coordinator stage progress. */
function startPipelineUiMonitor(ctx: ExtensionContext, config: ReturnType<typeof parseDelegateConfig>, workspaceId: string, pipelineId: string): void {
	const key = pipelineUiMonitorKey(ctx, pipelineId);
	stopPipelineUiMonitor(key);
	const coordinator = createPipelineCoordinator(ctx, config, workspaceId);
	const monitor = {
		timer: undefined as unknown as ReturnType<typeof setInterval>,
		polling: false,
	};
	const poll = async (): Promise<void> => {
		if (monitor.polling) return;
		monitor.polling = true;
		try {
			const progress = await coordinator.progress(pipelineId);
			renderPipelineUi(ctx, progress);
			if (TERMINAL_PIPELINE_STATUSES.has(progress.state.status)) stopPipelineUiMonitor(key);
		} catch (error) {
			ctx.ui.setStatus(PIPELINE_UI_STATUS_KEY, `pipeline ${pipelineId} · ERROR`);
			ctx.ui.setWidget(PIPELINE_UI_WIDGET_KEY, [`Herdr pipeline ${pipelineId} · ERROR`, error instanceof Error ? error.message : String(error)]);
			stopPipelineUiMonitor(key);
		} finally {
			monitor.polling = false;
		}
	};
	monitor.timer = setInterval(() => { void poll(); }, PIPELINE_UI_POLL_MS);
	monitor.timer.unref?.();
	pipelineUiMonitors.set(key, monitor);
	void poll();
}

/** Stops all parent-side monitors when the Pi extension session is replaced or shut down. */
function stopAllPipelineUiMonitors(): void {
	for (const key of pipelineUiMonitors.keys()) stopPipelineUiMonitor(key);
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
			if (params.action === "pipeline" && result.details?.submission?.pipelineId && workspaceId && result.details.status !== "ERROR") {
				startPipelineUiMonitor(ctx, config, workspaceId, result.details.submission.pipelineId);
			}
			await debug.log("tool.request.result", { action: params.action, status: result.details?.status, communicationFile: result.details?.communicationFile });
			return result;
		} catch (error) {
			await debug.log("tool.request.error", { action: params.action, error: debugError(error) });
			throw error;
		}
	});
}

/** Direct leaf overrides shared by the slash command and automatic input router. */
interface DirectDelegateOverrides {
	/** Configured runtime role used for timeout/profile resolution. */
	role: string;
	/** Optional explicit external agent selected by the user. */
	agent?: AutomaticDelegateAgent;
}

type DelegateExecutor = (
	params: DelegateToolParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
) => Promise<AgentToolResult<DelegateToolDetails>>;

/** Formats a compact user-facing result without dumping task text or child output. */
function formatDelegateNotification(result: AgentToolResult<DelegateToolDetails>): string {
	const details = result.details;
	const status = details?.status ?? "UNKNOWN";
	const summary = details?.result?.completion?.summary ?? details?.error;
	const communicationFile = details?.communicationFile;
	return [
		`ry_herdr_delegate_tool: ${status}`,
		summary ? `SUMMARY: ${summary}` : undefined,
		communicationFile ? `COMMUNICATION: ${communicationFile}` : undefined,
	].filter((line): line is string => line !== undefined).join("\n");
}

/** Shows the direct delegate result while keeping the command and input paths consistent. */
function delegateNotificationType(result: AgentToolResult<DelegateToolDetails>): "info" | "warning" | "error" {
	if (result.details?.status === "ERROR") return "error";
	return result.details?.status === "DONE" ? "info" : "warning";
}

/** Runs one direct leaf request and reports its structured status through the Pi UI. */
async function runDirectDelegate(
	task: string,
	ctx: ExtensionContext,
	overrides: DirectDelegateOverrides,
	executor: DelegateExecutor,
): Promise<void> {
	ctx.ui.setWorkingMessage("Running Herdr delegate...");
	ctx.ui.setWorkingVisible(true);
	try {
		const result = await executor({ action: "delegate", task, role: overrides.role, agent: overrides.agent }, ctx, ctx.signal);
		ctx.ui.notify(formatDelegateNotification(result), delegateNotificationType(result));
	} catch (error) {
		ctx.ui.notify(`ry_herdr_delegate_tool: ERROR\n${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setWorkingMessage();
	}
}

/**
 * Creates the slash-command handler that executes a supplied task as a leaf.
 * @param executor Runtime executor, injectable for command regression tests.
 * @returns A Pi command handler accepting the task after `/ry-herdr-delegate`.
 * TEST:ry-herdr-delegate/tool.test.ts[createDelegateCommandHandler]
 */
export function createDelegateCommandHandler(executor: DelegateExecutor = executeDelegateTool): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
	return async (args, ctx) => {
		const task = args.trim();
		if (!task) {
			ctx.ui.notify("Usage: /ry-herdr-delegate <task>", "warning");
			return;
		}
		await runDirectDelegate(task, ctx, { role: "delegate" }, executor);
	};
}

/**
 * Creates the pre-agent input handler for explicit Codex/Claude work directives.
 * @param executor Runtime executor, injectable for automatic-routing regression tests.
 * @returns A Pi input handler that handles only actionable direct-agent prompts.
 * TEST:ry-herdr-delegate/tool.test.ts[createAutomaticDelegateInputHandler]
 */
export function createAutomaticDelegateInputHandler(executor: DelegateExecutor = executeDelegateTool): (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult> {
	return async (event, ctx) => {
		if (event.source === "extension" || event.streamingBehavior || ctx.mode !== "tui" || !ctx.isIdle()) return { action: "continue" };
		const request = detectAutomaticDelegateRequest(event.text);
		if (!request) return { action: "continue" };
		await runDirectDelegate(request.task, ctx, { role: "worker", agent: request.agent }, executor);
		return { action: "handled" };
	};
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

/** Registers the structured tool, executable slash command, and direct-agent input router. */
export function registerDelegateTool(pi: ExtensionAPI): void {
	const definition: ToolDefinition<typeof DelegateToolParameters, DelegateToolDetails> = {
		name: "ry_herdr_delegate_tool",
		label: "Herdr Delegate",
		description: "Run one structured leaf or pipeline action through the project-owned Herdr gateway.",
		promptSnippet: "Use the structured Herdr delegate runtime for leaf or pipeline work",
		promptGuidelines: ["Use action=delegate for one leaf stage, action=pipeline for non-blocking submission, pipeline.status for replayed state, pipeline.answer or pipeline.stop for durable control, and pipeline.coordinator only from the exact coordinator pane/session."],
		parameters: DelegateToolParameters,
		renderCall: (args, theme) => formatDelegateToolCall(args, theme),
		renderResult: (result, options, theme, context) => renderDelegateToolResult(result, options, theme, context.isError),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => executeDelegateTool(params, ctx, signal),
	};
	pi.registerTool(definition);
	pi.registerCommand("ry-herdr-delegate", {
		description: "Execute one Herdr delegate leaf task: /ry-herdr-delegate <task>",
		handler: createDelegateCommandHandler(),
	});
	pi.on("input", createAutomaticDelegateInputHandler());
	pi.on("session_shutdown", () => {
		stopAllPipelineUiMonitors();
	});
}
