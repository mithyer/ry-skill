import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { debug, debugError, NOOP_DEBUG_LOGGER, summarizeDebugArgs, summarizeDebugText, type DebugLogger } from "../debug.ts";
import type {
	AgentTransportStatus,
	CreateTabInput,
	HerdrAgentOutput,
	HerdrAgentSnapshot,
	HerdrCapabilities,
	HerdrGateway,
	HerdrPane,
	HerdrSnapshot,
	MovePaneInput,
	PromptInput,
	SessionIdentity,
	SplitPaneInput,
	StartAgentInput,
	WaitInput,
} from "../types.ts";

/** Spawn function kept injectable so gateway tests never need a Herdr server. */
export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Options used to construct the production Herdr CLI gateway. */
export interface HerdrCliGatewayOptions {
	/** Herdr executable name or absolute path. */
	command?: string;
	/** Working directory for every Herdr CLI process. */
	cwd: string;
	/** Environment inherited by the Herdr CLI process. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Default command timeout. */
	timeoutMs?: number;
	/** Optional structured debug logger. */
	debugLogger?: DebugLogger;
	/** Injectable process creator for unit tests. */
	spawnProcess?: SpawnProcess;
	/** Optional delay seam used while a newly split pane becomes an available shell. */
	sleep?: (milliseconds: number) => Promise<void>;
}

/** Maximum attempts while Herdr asynchronously promotes a newly split pane into an available shell. */
const AGENT_START_ATTEMPTS = 30;

/** Delay between explicit `agent_pane_busy` startup retries. */
const AGENT_START_RETRY_MS = 100;

/** Maximum attempts while Herdr asynchronously promotes a settled agent into a readable terminal snapshot. */
const AGENT_READ_ATTEMPTS = 5;

/** Delay between explicit `agent_not_idle` terminal-read retries. */
const AGENT_READ_RETRY_MS = 100;

/** Maximum attempts while Herdr publishes exact session metadata after agent startup. */
const AGENT_SESSION_ATTEMPTS = 30;

/** Delay between exact session metadata reads during startup stabilization. */
const AGENT_SESSION_RETRY_MS = 100;

/** Maximum time allowed for the fixed no-op prompt that establishes external-agent session identity. */
const AGENT_SESSION_BOOTSTRAP_TIMEOUT_MS = 10_000;

/** Fixed no-op prompt used only to make an external session identity observable before task relay. */
const AGENT_SESSION_BOOTSTRAP_PROMPT = "RY_HERDR_SESSION_BOOTSTRAP: Do not modify files, run commands, or delegate. Reply exactly: READY";

/** Structured error raised when Herdr cannot satisfy a CLI capability. */
export class HerdrCapabilityError extends Error {
	/** CLI argument vector associated with the unsupported operation. */
	readonly args: readonly string[];
	/** Captured stdout, when available. */
	readonly stdout: string;
	/** Captured stderr, when available. */
	readonly stderr: string;

	/**
	 * Creates a capability error with the exact command evidence.
	 *
	 * @param message Human-readable capability failure.
	 * @param args CLI arguments used by the probe or operation.
	 * @param stdout Captured standard output.
	 * @param stderr Captured standard error.
	 */
	constructor(message: string, args: readonly string[], stdout = "", stderr = "") {
		super(message);
		this.name = "HerdrCapabilityError";
		this.args = [...args];
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

/** Structured non-zero, timeout, or process-launch failure from Herdr. */
export class HerdrCommandError extends HerdrCapabilityError {
	/** Exit code when the process exited normally. */
	readonly code: number | null;
	/** Signal that ended the process, when any. */
	readonly signal: NodeJS.Signals | null;
	/** Whether the gateway's own command timer, rather than the parent signal, aborted the process. */
	readonly timedOut: boolean;

	/**
	 * Creates a command failure with process termination details.
	 *
	 * @param message Human-readable command failure.
	 * @param args CLI arguments used by the command.
	 * @param code Process exit code.
	 * @param signal Process termination signal.
	 * @param stdout Captured standard output.
	 * @param stderr Captured standard error.
	 * @param timedOut Whether the gateway command timer caused the abort.
	 */
	constructor(
		message: string,
		args: readonly string[],
		code: number | null,
		signal: NodeJS.Signals | null,
		stdout: string,
		stderr: string,
		timedOut = false,
	) {
		super(message, args, stdout, stderr);
		this.name = "HerdrCommandError";
		this.code = code;
		this.signal = signal;
		this.timedOut = timedOut;
	}
}

/** Returns a plain object when a decoded Herdr response has object shape. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Unwraps the stable CLI response envelope while preserving non-object payloads. */
function unwrapResult(value: unknown): unknown {
	const record = asRecord(value);
	return record && "result" in record ? record.result : value;
}

/** Reads a required non-empty string field from a response object. */
function requiredString(record: Record<string, unknown>, keys: readonly string[], description: string): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	throw new HerdrCapabilityError(`Herdr response is missing ${description}`, keys);
}

/** Extracts Herdr's structured error code without matching arbitrary diagnostic text. */
function herdrErrorCode(error: unknown): string | undefined {
	if (!(error instanceof HerdrCommandError)) return undefined;
	for (const candidate of [error.stderr, error.stdout]) {
		try {
			const outer = asRecord(JSON.parse(candidate));
			const nested = asRecord(outer?.error);
			if (typeof nested?.code === "string") return nested.code;
		} catch {
			// A malformed error payload is not eligible for retry.
		}
	}
	return undefined;
}

/** Returns whether Herdr has not yet promoted a new split pane into an agent-startable shell. */
function isTransientAgentPaneBusy(error: unknown): boolean {
	return herdrErrorCode(error) === "agent_pane_busy";
}

/** Returns whether Herdr has not yet made a settled agent terminal readable. */
function isTransientAgentRead(error: unknown): boolean {
	return herdrErrorCode(error) === "agent_not_idle";
}

/** Normalizes a raw Herdr agent session object. */
function normalizeSession(value: unknown): SessionIdentity | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (typeof record.kind !== "string" || typeof record.source !== "string" || typeof record.value !== "string") return undefined;
	if (!record.kind || !record.source || !record.value) return undefined;
	return { kind: record.kind, source: record.source, value: record.value };
}

/** Normalizes an agent response from `agent get`, `agent wait`, or a snapshot. */
function normalizeAgent(value: unknown, fallbackTarget?: string): HerdrAgentSnapshot {
	let record = asRecord(unwrapResult(value));
	if (!record) throw new HerdrCapabilityError("Herdr agent response is not an object", []);
	if (asRecord(record.agent)) record = asRecord(record.agent)!;
	// Herdr exposes `agent` as the implementation kind (for example, `pi`) and `name` as the unique prompt target.
	const agent = typeof record.name === "string" && record.name.length > 0
		? record.name
		: fallbackTarget ?? (typeof record.agent === "string" ? record.agent : undefined);
	if (!agent) throw new HerdrCapabilityError("Herdr agent response is missing agent", []);
	const statusValue = record.agent_status ?? record.status;
	const status: AgentTransportStatus =
		statusValue === "working" || statusValue === "blocked" || statusValue === "idle" || statusValue === "done" || statusValue === "unknown"
			? statusValue
			: "unknown";
	const paneId = record.pane_id ?? record.paneId;
	if (typeof paneId !== "string" || paneId.length === 0) {
		throw new HerdrCapabilityError("Herdr agent response is missing pane_id", []);
	}
	return {
		agent,
		status,
		paneId,
		workspaceId: typeof record.workspace_id === "string" ? record.workspace_id : undefined,
		tabId: typeof record.tab_id === "string" ? record.tab_id : undefined,
		cwd: typeof record.cwd === "string" ? record.cwd : undefined,
		agentSession: normalizeSession(record.agent_session ?? record.agentSession),
	};
}

/** Normalizes a raw pane response from split or tab creation. */
function normalizePane(value: unknown): HerdrPane {
	const record = asRecord(unwrapResult(value));
	if (!record) throw new HerdrCapabilityError("Herdr pane response is not an object", []);
	const pane = asRecord(record.pane) ?? asRecord(record.root_pane) ?? record;
	const paneId = pane.pane_id ?? pane.paneId ?? pane.id;
	if (typeof paneId !== "string" || paneId.length === 0) throw new HerdrCapabilityError("Herdr response is missing pane_id", []);
	return {
		paneId,
		workspaceId: typeof (pane.workspace_id ?? record.workspace_id) === "string" ? (pane.workspace_id ?? record.workspace_id) as string : undefined,
		tabId: typeof (pane.tab_id ?? record.tab_id) === "string" ? (pane.tab_id ?? record.tab_id) as string : undefined,
	};
}

/** Converts a raw snapshot agent entry into the normalized agent representation. */
function normalizeSnapshotAgents(value: unknown): HerdrAgentSnapshot[] {
	const outer = asRecord(value);
	const result = asRecord(outer?.result);
	const snapshot = asRecord(result?.snapshot) ?? asRecord(unwrapResult(value));
	const agentsValue = snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : [];
	return agentsValue.map((agent) => normalizeAgent(agent));
}

/** Formats an argv array for diagnostic errors without executing shell syntax. */
function describeCommand(command: string, args: readonly string[]): string {
	return [command, ...args].map((item) => JSON.stringify(item)).join(" ");
}

/** Production gateway that executes every Herdr operation through `spawn` with shell disabled. */
export class HerdrCliGateway implements HerdrGateway {
	/** Executable used for all Herdr operations. */
	private readonly command: string;
	/** Working directory inherited by Herdr processes. */
	private readonly cwd: string;
	/** Environment inherited and explicitly merged into Herdr processes. */
	private readonly env: NodeJS.ProcessEnv;
	/** Default operation timeout. */
	private readonly timeoutMs: number;
	/** Injectable process creator. */
	private readonly spawnProcess: SpawnProcess;
	/** Delay implementation used only for bounded newly split-pane startup retries. */
	private readonly sleep: (milliseconds: number) => Promise<void>;
	/** Best-effort logger for every Herdr command boundary. */
	private readonly debugLogger: DebugLogger;
	/** Cached capability probe result, shared by all gateway operations. */
	private probeResult?: Promise<HerdrCapabilities>;

	/**
	 * Creates a gateway with explicit process execution settings.
	 *
	 * @param options Gateway executable, cwd, environment, timeout, and test seam.
	 */
	constructor(options: HerdrCliGatewayOptions) {
		this.command = options.command ?? "herdr";
		this.cwd = options.cwd;
		this.env = { ...process.env, ...(options.env ?? {}) };
		this.timeoutMs = options.timeoutMs ?? 300000;
		this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
		this.sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
		this.debugLogger = options.debugLogger ?? debug;
	}

	/** Verifies Herdr 0.8+ and the normalized JSON snapshot contract before side effects.
	 *
	 * @param signal Optional cancellation signal for the probe processes.
	 * @returns Cached Herdr capability metadata.
	 */
	async probe(signal?: AbortSignal): Promise<HerdrCapabilities> {
		this.probeResult ??= this.runProbe(signal);
		return this.probeResult;
	}

	/** Runs the version and snapshot capability checks exactly once per gateway instance. */
	private async runProbe(signal?: AbortSignal): Promise<HerdrCapabilities> {
		const versionResult = await this.run(["--version"], signal);
		const match = versionResult.stdout.trim().match(/(\d+)\.(\d+)\.(\d+)/);
		if (!match) throw new HerdrCapabilityError("Herdr version output is invalid", ["--version"], versionResult.stdout, versionResult.stderr);
		const version = `${match[1]}.${match[2]}.${match[3]}`;
		if (Number(match[1]) < 0 || (Number(match[1]) === 0 && Number(match[2]) < 8)) throw new HerdrCapabilityError(`Herdr 0.8+ is required, found ${version}`, ["--version"], versionResult.stdout, versionResult.stderr);
		const snapshot = await this.snapshotRaw(signal);
		const outer = asRecord(snapshot.raw);
		const result = asRecord(outer?.result);
		const snapshotRecord = asRecord(result?.snapshot) ?? asRecord(unwrapResult(snapshot.raw));
		if (!snapshotRecord || !Array.isArray(snapshotRecord.agents)) throw new HerdrCapabilityError("Herdr snapshot JSON shape is invalid", ["api", "snapshot"]);
		return { herdrVersion: version, jsonSnapshot: snapshot.agents.every((agent) => Boolean(agent.agent && agent.paneId)) };
	}

	/** Reads and normalizes a snapshot with an optional cancellation signal for probing. */
	private async snapshotRaw(signal?: AbortSignal): Promise<HerdrSnapshot> {
		const raw = await this.runJson(["api", "snapshot"], signal);
		return { raw, agents: normalizeSnapshotAgents(raw) };
	}
	/**
	 * Executes one Herdr child process and captures both output streams.
	 *
	 * @param args Herdr CLI argv array.
	 * @param signal Optional external cancellation signal.
	 * @param timeoutMs Optional operation timeout.
	 * @returns Captured process result.
	 */
	private run(args: readonly string[], signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<{ stdout: string; stderr: string }> {
		const startedAt = Date.now();
		const debugArgs = summarizeDebugArgs(args);
		void this.debugLogger.log("herdr.command.start", {
			command: this.command,
			args: debugArgs,
			cwd: this.cwd,
			timeoutMs,
			signalAborted: signal?.aborted ?? false,
		});
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				const error = new HerdrCommandError(`Herdr command aborted: ${describeCommand(this.command, args)}`, args, null, null, "", "");
				void this.debugLogger.log("herdr.command.aborted-before-start", { command: this.command, args: debugArgs, elapsedMs: Date.now() - startedAt, error: debugError(error) });
				reject(error);
				return;
			}
			const controller = new AbortController();
			const abortFromParent = (): void => {
				void this.debugLogger.log("herdr.command.abort-requested", { command: this.command, args: debugArgs, reason: signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? "parent signal") });
				controller.abort(signal?.reason);
			};
			signal?.addEventListener("abort", abortFromParent, { once: true });
			let child: ChildProcess;
			try {
				child = this.spawnProcess(this.command, args, {
					cwd: this.cwd,
					env: this.env,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					signal: controller.signal,
				});
				void this.debugLogger.log("herdr.command.spawned", { command: this.command, args: debugArgs, cwd: this.cwd, elapsedMs: Date.now() - startedAt });
			} catch (error) {
				signal?.removeEventListener("abort", abortFromParent);
				const wrapped = new HerdrCommandError(`Unable to start ${describeCommand(this.command, args)}: ${String(error)}`, args, null, null, "", "");
				void this.debugLogger.log("herdr.command.spawn-error", { command: this.command, args: debugArgs, elapsedMs: Date.now() - startedAt, error: debugError(wrapped) });
				reject(wrapped);
				return;
			}
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				void this.debugLogger.log("herdr.command.timeout", { command: this.command, args: debugArgs, timeoutMs, elapsedMs: Date.now() - startedAt });
				controller.abort(new Error(`timeout after ${timeoutMs}ms`));
			}, timeoutMs);
			const finish = (error: Error | undefined, code: number | null = null, terminationSignal: NodeJS.Signals | null = null): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abortFromParent);
				const details = {
					command: this.command,
					args: debugArgs,
					cwd: this.cwd,
					code,
					signal: terminationSignal,
					elapsedMs: Date.now() - startedAt,
					stdout: summarizeDebugText(stdout),
					stderr: summarizeDebugText(stderr),
					...(error ? { error: debugError(error) } : {}),
				};
				if (error) {
					const wrapped = new HerdrCommandError(error.message, args, code, terminationSignal, stdout, stderr, timedOut);
					void this.debugLogger.log("herdr.command.failed", details);
					reject(wrapped);
					return;
				}
				if (code !== 0) {
					const wrapped = new HerdrCommandError(`${describeCommand(this.command, args)} failed: ${stderr.trim() || stdout.trim() || `exit code ${code}`}`, args, code, terminationSignal, stdout, stderr);
					void this.debugLogger.log("herdr.command.failed", { ...details, error: debugError(wrapped) });
					reject(wrapped);
					return;
				}
				void this.debugLogger.log("herdr.command.succeeded", details);
				resolve({ stdout, stderr });
			};
			child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
			child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
			child.once("error", (error) => finish(error));
			child.once("close", (code, terminationSignal) => {
				if (controller.signal.aborted) {
					const reason = controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Herdr command aborted");
					finish(reason, code, terminationSignal);
					return;
				}
				finish(undefined, code, terminationSignal);
			});
		});
	}

	/**
	 * Runs a command and decodes the JSON wrapper returned by Herdr.
	 *
	 * @param args Herdr CLI argv array.
	 * @param signal Optional cancellation signal.
	 * @param timeoutMs Optional command timeout.
	 * @returns Decoded JSON payload.
	 */
	private async runJson(args: readonly string[], signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<unknown> {
		const result = await this.run(args, signal, timeoutMs);
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new HerdrCapabilityError(`Herdr returned invalid JSON for ${describeCommand(this.command, args)}`, args, result.stdout, result.stderr);
		}
	}

	/**
	 * Creates a sibling pane from an explicit source pane.
	 *
	 * @param input Split direction, source pane, cwd, env, and focus settings.
	 * @returns Normalized pane metadata.
	 */
	async splitPane(input: SplitPaneInput): Promise<HerdrPane> {
		const args = ["pane", "split", "--pane", input.sourcePaneId, "--direction", input.direction ?? "right"];
		if (input.cwd) args.push("--cwd", input.cwd);
		for (const [key, value] of Object.entries(input.env ?? {})) args.push("--env", `${key}=${value}`);
		args.push(input.focus ? "--focus" : "--no-focus");
		return normalizePane(await this.runJson(args, input.signal));
	}

	/**
	 * Waits for the exact session identity to become visible after Herdr starts an agent.
	 *
	 * @param target Agent name returned by the start command.
	 * @returns The latest normalized agent snapshot, including exact session metadata when available.
	 */
	private async getStartedAgent(target: string, signal?: AbortSignal): Promise<HerdrAgentSnapshot> {
		let snapshot: HerdrAgentSnapshot | undefined;
		for (let attempt = 1; attempt <= AGENT_SESSION_ATTEMPTS; attempt += 1) {
			snapshot = await this.getAgent(target, signal);
			if (snapshot.agentSession) return snapshot;
			if (attempt === AGENT_SESSION_ATTEMPTS) break;
			await this.debugLogger.log("herdr.agent.session.retry", {
				target,
				attempt,
				maxAttempts: AGENT_SESSION_ATTEMPTS,
				retryMs: AGENT_SESSION_RETRY_MS,
			}, "trace");
			await this.sleep(AGENT_SESSION_RETRY_MS);
		}
		return snapshot!;
	}

	/**
	 * Sends a fixed no-op turn when an external CLI has not published its session identity yet.
	 *
	 * @param target Agent name returned by the start command.
	 * @returns A promise that settles after the bounded bootstrap attempt.
	 */
	private async bootstrapAgentSession(target: string, signal?: AbortSignal): Promise<void> {
		await this.debugLogger.log("herdr.agent.session.bootstrap.start", {
			target,
			timeoutMs: AGENT_SESSION_BOOTSTRAP_TIMEOUT_MS,
		});
		try {
			await this.prompt({
				target,
				text: AGENT_SESSION_BOOTSTRAP_PROMPT,
				wait: true,
				timeoutMs: AGENT_SESSION_BOOTSTRAP_TIMEOUT_MS,
				signal,
			});
			await this.debugLogger.log("herdr.agent.session.bootstrap.result", { target });
		} catch (error) {
			// Onboarding or authentication can block the probe; the caller still fails closed below.
			await this.debugLogger.log("herdr.agent.session.bootstrap.error", {
				target,
				error: debugError(error),
			}, "warn");
		}
	}

	/**
	 * Starts a supported agent with its final validated argv.
	 *
	 * @param input Agent name, kind, pane, and argv.
	 * @returns Normalized agent metadata after startup.
	 */
	async startAgent(input: StartAgentInput): Promise<HerdrAgentSnapshot> {
		if (input.agentArgs.length === 0 || input.agentArgs.some((arg) => typeof arg !== "string")) {
			throw new Error("Herdr startAgent requires a non-empty string agentArgs array");
		}
		const args = ["agent", "start", input.name, "--kind", input.kind, "--pane", input.paneId, "--", ...input.agentArgs];
		for (let attempt = 1; attempt <= AGENT_START_ATTEMPTS; attempt += 1) {
			try {
				await this.runJson(args, input.signal);
				const initial = await this.getAgent(input.name, input.signal);
				if (initial.agentSession) return initial;
				await this.bootstrapAgentSession(input.name, input.signal);
				return this.getStartedAgent(input.name, input.signal);
			} catch (error) {
				if (!isTransientAgentPaneBusy(error) || attempt === AGENT_START_ATTEMPTS) throw error;
				await this.debugLogger.log("herdr.agent.start.retry", {
					name: input.name,
					paneId: input.paneId,
					attempt,
					maxAttempts: AGENT_START_ATTEMPTS,
					retryMs: AGENT_START_RETRY_MS,
				});
				await this.sleep(AGENT_START_RETRY_MS);
			}
		}
		throw new Error("Herdr agent startup retry loop ended unexpectedly");
	}

	/**
	 * Sends a relay envelope to an agent.
	 *
	 * @param input Target, text, optional wait, and timeout.
	 * @returns Normalized response metadata when the CLI returns an agent object.
	 */
	async prompt(input: PromptInput): Promise<HerdrAgentSnapshot | undefined> {
		const args = ["agent", "prompt", input.target, input.text];
		if (input.wait) args.push("--wait");
		if (input.timeoutMs !== undefined) args.push("--timeout", String(input.timeoutMs));
		try {
			const result = await this.runJson(args, input.signal, input.timeoutMs ?? this.timeoutMs);
			try {
				return normalizeAgent(result, input.target);
			} catch {
				return undefined;
			}
		} catch (error) {
			// Herdr 0.8 can report a completed fast turn as stalled when its state sequence never leaves idle.
			if (!input.wait || herdrErrorCode(error) !== "agent_prompt_stalled") throw error;
			await this.debugLogger.log("herdr.agent.prompt-stalled", {
				target: input.target,
				timeoutMs: input.timeoutMs,
				fallback: "get-agent",
			}, "warn");
			return await this.getAgent(input.target, input.signal);
		}
	}

	/**
	 * Waits for one of the requested Herdr transport states.
	 *
	 * @param input Target, accepted states, and timeout.
	 * @returns Normalized settled agent metadata.
	 */
	async waitFor(input: WaitInput): Promise<HerdrAgentSnapshot> {
		const args = ["agent", "wait", input.target];
		for (const status of input.until ?? ["idle", "done", "blocked"]) args.push("--until", status);
		if (input.timeoutMs !== undefined) args.push("--timeout", String(input.timeoutMs));
		return normalizeAgent(await this.runJson(args, input.signal, input.timeoutMs ?? this.timeoutMs), input.target);
	}

	/**
	 * Gets exact current agent metadata.
	 *
	 * @param target Herdr agent name or target.
	 * @returns Normalized agent snapshot.
	 */
	async getAgent(target: string, signal?: AbortSignal): Promise<HerdrAgentSnapshot> {
		return normalizeAgent(await this.runJson(["agent", "get", target], signal), target);
	}

	/**
	 * Reads recent terminal output from an agent.
	 *
	 * @param target Herdr agent name or target.
	 * @returns Raw terminal output text.
	 */
	async readAgent(target: string, signal?: AbortSignal): Promise<HerdrAgentOutput> {
		const args = ["agent", "read", target, "--source", "recent-unwrapped", "--lines", "500", "--format", "text"];
		let result: { stdout: string; stderr: string } | undefined;
		for (let attempt = 1; attempt <= AGENT_READ_ATTEMPTS; attempt += 1) {
			try {
				result = await this.run(args, signal);
				break;
			} catch (error) {
				if (!isTransientAgentRead(error) || attempt === AGENT_READ_ATTEMPTS) throw error;
				await this.debugLogger.log("herdr.agent.read.retry", {
					target,
					attempt,
					maxAttempts: AGENT_READ_ATTEMPTS,
					retryMs: AGENT_READ_RETRY_MS,
				});
				await this.sleep(AGENT_READ_RETRY_MS);
			}
		}
		if (!result) throw new Error("Herdr agent read retry loop ended unexpectedly");
		const trimmed = result.stdout.trim();
		if (!trimmed.startsWith("{")) return { text: result.stdout };
		try {
			const decoded = unwrapResult(JSON.parse(trimmed));
			if (typeof decoded === "string") return { text: decoded };
			const record = asRecord(decoded);
			const text = record?.text ?? record?.output ?? record?.content;
			return { text: typeof text === "string" ? text : result.stdout };
		} catch {
			return { text: result.stdout };
		}
	}

	/**
	 * Creates a non-focused tab in a specific workspace.
	 *
	 * @param input Workspace, cwd, label, and focus settings.
	 * @returns Created tab and optional root pane identifiers.
	 */
	async createTab(input: CreateTabInput): Promise<{ tabId: string; paneId?: string }> {
		const args = ["tab", "create", "--workspace", input.workspaceId, "--cwd", input.cwd, "--label", input.label, input.focus ? "--focus" : "--no-focus"];
		const raw = unwrapResult(await this.runJson(args, input.signal));
		const record = asRecord(raw);
		if (!record) throw new HerdrCapabilityError("Herdr tab response is not an object", args);
		const tabRecord = asRecord(record.tab);
		const tabId = typeof tabRecord?.tab_id === "string" ? tabRecord.tab_id : typeof record.tab_id === "string" ? record.tab_id : undefined;
		if (!tabId) throw new HerdrCapabilityError("Herdr tab response is missing tab_id", args);
		const pane = asRecord(record.root_pane);
		return { tabId, paneId: typeof pane?.pane_id === "string" ? pane.pane_id : undefined };
	}

	/**
	 * Moves a pane into an existing or newly created tab.
	 *
	 * @param input Pane, destination, label, workspace, and focus settings.
	 * @returns Destination tab identifier when Herdr provides it.
	 */
	async movePane(input: MovePaneInput): Promise<{ tabId?: string }> {
		const args = ["pane", "move", input.paneId];
		if (input.tabId) args.push("--tab", input.tabId);
		if (input.newTab) args.push("--new-tab");
		if (input.tabLabel) args.push(input.newTab ? "--label" : "--tab-label", input.tabLabel);
		if (input.workspaceId) args.push("--workspace", input.workspaceId);
		args.push(input.focus ? "--focus" : "--no-focus");
		const raw = unwrapResult(await this.runJson(args, input.signal));
		const record = asRecord(raw);
		const tab = asRecord(record?.tab);
		return { tabId: typeof tab?.tab_id === "string" ? tab.tab_id : typeof record?.tab_id === "string" ? record.tab_id : undefined };
	}

	/**
	 * Closes a pane after semantic completion.
	 *
	 * @param paneId Pane identifier to close.
	 * @returns A promise resolved after Herdr confirms the close.
	 */
	async closePane(paneId: string, signal?: AbortSignal): Promise<void> {
		await this.runJson(["pane", "close", paneId], signal);
	}

	/**
	 * Reads and normalizes the live Herdr API snapshot.
	 *
	 * @returns Raw snapshot plus normalized agent entries.
	 */
	async snapshot(signal?: AbortSignal): Promise<HerdrSnapshot> {
		return this.snapshotRaw(signal);
	}
}
