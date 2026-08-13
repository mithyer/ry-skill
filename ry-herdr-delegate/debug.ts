import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import lockfile from "proper-lockfile";

import type { DebugConfig, DebugEventLevel, DebugLevel, SessionIdentity } from "./types.ts";

/** Current debug event-log schema written by this runtime. */
const DEBUG_SCHEMA_VERSION = 1;
/** Default project-local directory containing one debug JSONL file per Pi session. */
export const DEFAULT_DEBUG_DIRECTORY = ".pi/agent/ry-herdr-delegate/debug";
/** Maximum text retained in one debug preview before truncation. */
const MAX_DEBUG_PREVIEW = 8000;
/** Numeric order used to filter events by configured verbosity. */
const DEBUG_LEVEL_ORDER: Record<DebugLevel, number> = {
	off: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
	trace: 5,
};
/** Keys whose values must never be copied to a debug log. */
const SENSITIVE_KEY = /(token|secret|password|passwd|cookie|authorization|api[-_]?key|private[-_]?key|credential|refresh[-_]?token|access[-_]?token)/i;
/** Common inline secret forms that can occur in command output or task text. */
const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
	/(bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
	/((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[:=]\s*["']?)[^\s,"']+/gi,
];
/** Current logger module path, excluded while selecting the first business stack frame. */
const DEBUG_MODULE_PATH = resolve(fileURLToPath(import.meta.url));

/** Context captured in the first line of every newly created debug log. */
export interface DebugContext {
	/** Pi coding-agent package version, when it can be discovered. */
	piVersion: string;
	/** Version of the ry-skill package that produced the log. */
	rySkillVersion: string;
	/** Node.js runtime version. */
	nodeVersion: string;
	/** Operating-system platform. */
	platform: string;
	/** Operating-system architecture. */
	arch: string;
	/** Process identifier that opened the logger. */
	pid: number;
	/** Parent process identifier, when available. */
	ppid: number;
	/** Project/runtime working directory. */
	cwd: string;
	/** Project root used by the runtime. */
	projectRoot?: string;
	/** Herdr workspace identifier for this invocation. */
	workspaceId?: string;
	/** Herdr pane identifier for this invocation. */
	paneId?: string;
	/** Exact Pi session identity for this invocation. */
	piSession?: SessionIdentity;
	/** Configuration file used to resolve debug settings. */
	configFile?: string;
	/** Herdr executable used by the gateway. */
	herdrCommand: string;
	/** Absolute JSONL file path selected for this session. */
	debugFile: string;
	/** Effective identity used to select this per-session debug file. */
	debugSession: SessionIdentity;
	/** Configured maximum debug event level. */
	debugLevel: DebugLevel;
}

/** Options used to create a runtime debug logger. */
export interface DebugLoggerOptions {
	/** Parsed debug configuration. */
	config: DebugConfig;
	/** Working directory used to resolve relative debug paths. */
	cwd: string;
	/** Project root included in the debug context. */
	projectRoot?: string;
	/** Current Herdr workspace identifier. */
	workspaceId?: string;
	/** Current Herdr pane identifier. */
	paneId?: string;
	/** Current Pi session identity. */
	piSession?: SessionIdentity;
	/** Path of the global configuration file. */
	configFile?: string;
	/** Herdr executable name or path. */
	herdrCommand?: string;
	/** Optional explicit Pi version for deterministic tests or hosts. */
	piVersion?: string;
	/** Optional explicit ry-skill version for deterministic tests or hosts. */
	rySkillVersion?: string;
}

/** Automatically captured V8 source location for one debug record. */
export interface DebugCallsite {
	/** Project-relative source path when available, otherwise an absolute path or `unknown`. */
	file: string;
	/** Calling function or method name reported by the V8 stack. */
	method: string;
	/** One-based source line, or zero when V8 did not expose a usable frame. */
	line: number;
	/** One-based source column, or zero when V8 did not expose a usable frame. */
	column: number;
}

/** Small logging boundary shared by the tool, gateway, engine, and coordinator. */
export interface DebugLogger {
	/** Configured maximum verbosity, or `off` for a disabled logger. */
	readonly level: DebugLevel;
	/** Whether this logger writes a file. */
	readonly enabled: boolean;
	/** Absolute JSONL file path when logging is enabled. */
	readonly file?: string;
	/** Appends one structured debug event using its inferred or explicit level. */
	log(event: string, details?: Record<string, unknown>, level?: DebugEventLevel): Promise<void>;
}

/** A reusable disabled logger for calls outside an active tool request. */
export const NOOP_DEBUG_LOGGER: DebugLogger = Object.freeze({
	level: "off",
	enabled: false,
	file: undefined,
	log: async (): Promise<void> => undefined,
});

/** Async context that keeps concurrent tool invocations from sharing logger state. */
const debugStorage = new AsyncLocalStorage<DebugLogger>();

/** Global debug facade; callers use it directly while the active logger remains request-scoped. */
export const debug: DebugLogger = Object.freeze({
	get level(): DebugLevel {
		return debugStorage.getStore()?.level ?? "off";
	},
	get enabled(): boolean {
		return debugStorage.getStore()?.enabled ?? false;
	},
	get file(): string | undefined {
		return debugStorage.getStore()?.file;
	},
	async log(event: string, details: Record<string, unknown> = {}, level?: DebugEventLevel): Promise<void> {
		try {
			await (debugStorage.getStore() ?? NOOP_DEBUG_LOGGER).log(event, details, level);
		} catch {
			// A host-provided logger must not make delegation or recovery fail.
		}
	},
});

/** Runs asynchronous runtime work with one request-scoped debug logger. */
export function withDebugLogger<T>(logger: DebugLogger, callback: () => T): T {
	return debugStorage.run(logger, callback);
}

/** File-backed JSONL logger with a cross-process sidecar lock and serialized local writes. */
class FileDebugLogger implements DebugLogger {
	/** Configured maximum verbosity written into the context record. */
	readonly level: DebugLevel;
	/** A file logger is enabled for every level except `off`. */
	readonly enabled = true;
	/** Absolute append-only debug event-log path. */
	readonly file: string;
	/** Root used to shorten captured caller paths for human inspection. */
	private readonly projectRoot?: string;
	/** Serializes calls from one process before the filesystem lock is acquired. */
	private writeQueue: Promise<void> = Promise.resolve();

	/** Creates a file logger after its context has been materialized and written. */
	constructor(file: string, level: DebugLevel, projectRoot?: string) {
		this.file = file;
		this.level = level;
		this.projectRoot = projectRoot;
	}

	/** Queues one event so concurrent instrumentation cannot reorder local writes arbitrarily. */
	async log(event: string, details: Record<string, unknown> = {}, level = inferDebugLevel(event)): Promise<void> {
		if (DEBUG_LEVEL_ORDER[level] > DEBUG_LEVEL_ORDER[this.level]) return;
		const callsite = captureDebugCallsite(this.projectRoot);
		this.writeQueue = this.writeQueue.then(async () => {
			try {
				await withFileLock(this.file, async () => {
					let existing = await readFile(this.file, "utf8");
					if (existing.length > 0 && !existing.endsWith("\n")) {
						await appendFile(this.file, "\n", "utf8");
						existing += "\n";
					}
					const lineCount = existing.length === 0 ? 0 : existing.trimEnd().split("\n").length;
					await appendFile(this.file, `${JSON.stringify({
						schemaVersion: DEBUG_SCHEMA_VERSION,
						recordType: "debug",
						recordLevel: level,
						seq: lineCount,
						timestamp: new Date().toISOString(),
						event,
						callsite,
						details: redactDebugValue(details),
					})}\n`, "utf8");
				});
			} catch {
				// Debug instrumentation is deliberately best effort and must not change task outcomes.
			}
		});
		await this.writeQueue;
	}
}

/** Infers the minimum level needed by a named event when callers omit it. */
function inferDebugLevel(event: string): DebugEventLevel {
	if (/(error|failed|exception|mismatch|invalid|missing|reject)/i.test(event)) return "error";
	if (/(warn|timeout|unknown|blocked|partial|fallback|defer|stalled|abort)/i.test(event)) return "warn";
	if (/(trace|lock|jsonl|event-log|stdout|stderr|command\.(start|spawned|succeeded)|checkpoint|poll|read|write)/i.test(event)) return "trace";
	if (/(pane|agent|session|status|stage|coordinator|pipeline|request|result|recovery|disposition)/i.test(event)) return "debug";
	return "info";
}

/** Creates a disabled logger or initializes a context-bearing session JSONL logger. */
export async function createDebugLogger(options: DebugLoggerOptions): Promise<DebugLogger> {
	if (options.config.level === "off") return NOOP_DEBUG_LOGGER;
	const projectRoot = options.projectRoot ?? options.cwd;
	const contextCallsite = captureDebugCallsite(projectRoot);
	const directory = resolveDebugDirectory(options.cwd, options.config.directory);
	const debugSession = options.piSession ?? { kind: "pi", source: "process", value: `${process.pid}` };
	const contextBase: Omit<DebugContext, "debugFile"> = {
		piVersion: options.piVersion ?? process.env.PI_VERSION ?? await packageVersion("@earendil-works/pi-coding-agent") ?? "unknown",
		rySkillVersion: options.rySkillVersion ?? await localRySkillVersion() ?? "unknown",
		nodeVersion: process.version,
		platform: process.platform,
		arch: process.arch,
		pid: process.pid,
		ppid: process.ppid,
		cwd: options.cwd,
		projectRoot: options.projectRoot,
		workspaceId: options.workspaceId,
		paneId: options.paneId,
		piSession: options.piSession,
		configFile: options.configFile,
		herdrCommand: options.herdrCommand ?? "herdr",
		debugSession,
		debugLevel: options.config.level,
	};
	try {
		const file = await resolveDebugSessionFile(directory, debugSession, (debugFile) => ({ ...contextBase, debugFile }), contextCallsite);
		return new FileDebugLogger(file, options.config.level, projectRoot);
	} catch {
		// An unwritable debug destination must not block delegation or pipeline recovery.
		return NOOP_DEBUG_LOGGER;
	}
}

/** Resolves a configured debug directory against cwd while supporting a leading home shortcut. */
function resolveDebugDirectory(cwd: string, configured?: string): string {
	const value = configured?.trim() || DEFAULT_DEBUG_DIRECTORY;
	if (value === "~") return resolve(homedir());
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return resolve(cwd, value);
}

/** Selects the readable base filename for one agent session. */
function sessionFileStem(session: SessionIdentity): string {
	const sourceValue = session.value.endsWith(".jsonl") ? basename(session.value) : session.value;
	const withoutExtension = sourceValue.endsWith(".jsonl") ? sourceValue.slice(0, -".jsonl".length) : sourceValue;
	const safe = withoutExtension.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe || `${session.kind}-session`;
}

/** Creates or reuses a session-specific debug file under a directory lock. */
async function resolveDebugSessionFile(
	directory: string,
	session: SessionIdentity,
	contextFactory: (file: string) => DebugContext,
	contextCallsite: DebugCallsite,
): Promise<string> {
	await mkdir(directory, { recursive: true });
	const release = await lockfile.lock(directory, {
		realpath: false,
		stale: 10000,
		retries: { retries: 20, minTimeout: 10, maxTimeout: 250, factor: 1.5 },
	});
	try {
		const base = sessionFileStem(session);
		let suffix = 1;
		for (;;) {
			const name = `${base}${suffix === 1 ? "" : `-${suffix}`}.jsonl`;
			const file = resolve(directory, name);
			try {
				const firstLine = (await readFile(file, "utf8")).split("\n", 1)[0];
				const parsed = JSON.parse(firstLine) as { context?: { debugSession?: unknown; piSession?: unknown } };
				if (sameSession(parsed.context?.debugSession ?? parsed.context?.piSession, session)) return file;
				suffix += 1;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					suffix += 1;
					continue;
				}
				const context = contextFactory(file);
				const handle = await open(file, "wx");
				try {
					await handle.writeFile(`${JSON.stringify({
						schemaVersion: DEBUG_SCHEMA_VERSION,
						recordType: "debug-context",
						recordLevel: "info",
						seq: 0,
						timestamp: new Date().toISOString(),
						callsite: contextCallsite,
						context: redactDebugValue(context),
					})}\n`, "utf8");
				} finally {
					await handle.close();
				}
				return file;
			}
		}
	} finally {
		await release();
	}
}

/** Acquires a sidecar lock while ensuring the target file exists. */
async function withFileLock<T>(file: string, callback: () => Promise<T>): Promise<T> {
	await mkdir(dirname(file), { recursive: true });
	try {
		await stat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const handle = await open(file, "wx");
		await handle.close();
	}
	const release = await lockfile.lock(file, {
		realpath: false,
		stale: 10000,
		retries: { retries: 20, minTimeout: 10, maxTimeout: 250, factor: 1.5 },
	});
	try {
		return await callback();
	} finally {
		await release();
	}
}

/** Compares the complete session identity triple used for log-file reuse. */
function sameSession(value: unknown, expected: SessionIdentity): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SessionIdentity>;
	return candidate.kind === expected.kind && candidate.source === expected.source && candidate.value === expected.value;
}

/** Parses one V8 stack frame into its method name, source location, and coordinates. */
function parseDebugStackFrame(frame: string): { method: string; location: string; line: number; column: number } | undefined {
	const named = frame.match(/^\s*at\s+(.*?)\s+\((.+):(\d+):(\d+)\)\s*$/);
	if (named) return { method: named[1] || "<anonymous>", location: named[2], line: Number(named[3]), column: Number(named[4]) };
	const anonymous = frame.match(/^\s*at\s+(.+):(\d+):(\d+)\s*$/);
	if (!anonymous) return undefined;
	return { method: "<anonymous>", location: anonymous[1], line: Number(anonymous[2]), column: Number(anonymous[3]) };
}

/** Converts one V8 stack location into an absolute source path when possible. */
function stackLocationToPath(location: string): string | undefined {
	try {
		if (location.startsWith("file://")) return fileURLToPath(location);
		if (isAbsolute(location)) return location;
	} catch {
		// Ignore malformed stack locations and continue looking for a usable caller frame.
	}
	return undefined;
}

/** Shortens an absolute caller path to the active project root when it stays inside that root. */
function displayCallsitePath(file: string, projectRoot?: string): string {
	const absolute = resolve(file);
	if (!projectRoot) return absolute;
	const relativeFile = relative(resolve(projectRoot), absolute);
	if (relativeFile && !relativeFile.startsWith("..") && !isAbsolute(relativeFile)) return relativeFile.replaceAll("\\", "/");
	return absolute;
}

/** Captures the first source frame outside this logging module without caller-supplied metadata. */
function captureDebugCallsite(projectRoot?: string): DebugCallsite {
	const fallback: DebugCallsite = { file: "unknown", method: "unknown", line: 0, column: 0 };
	let firstBusinessFrame: DebugCallsite | undefined;
	const stack = new Error().stack;
	if (!stack) return fallback;
	for (const frame of stack.split("\n").slice(1)) {
		const parsed = parseDebugStackFrame(frame);
		if (!parsed) continue;
		const file = stackLocationToPath(parsed.location);
		if (!file || resolve(file) === DEBUG_MODULE_PATH) continue;
		const candidate: DebugCallsite = {
			file: displayCallsitePath(file, projectRoot),
			method: parsed.method,
			line: parsed.line,
			column: parsed.column,
		};
		firstBusinessFrame ??= candidate;
		if (parsed.method === "<anonymous>") continue;
		// Preserve the innermost execution point while giving anonymous callbacks their containing method name.
		return firstBusinessFrame.method === "<anonymous>" ? { ...firstBusinessFrame, method: candidate.method } : firstBusinessFrame;
	}
	return firstBusinessFrame ?? fallback;
}

/** Reads the ry-skill package version from the package containing this module. */
async function localRySkillVersion(): Promise<string | undefined> {
	try {
		const packageFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		const value = JSON.parse(await readFile(packageFile, "utf8")) as { version?: unknown };
		return typeof value.version === "string" ? value.version : undefined;
	} catch {
		return undefined;
	}
}

/** Discovers a dependency package version from its resolved entrypoint. */
async function packageVersion(packageName: string): Promise<string | undefined> {
	try {
		const entry = fileURLToPath(import.meta.resolve(packageName));
		let directory = dirname(entry);
		for (let depth = 0; depth < 6; depth += 1) {
			try {
				const value = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
				if (value.name === packageName && typeof value.version === "string") return value.version;
			} catch {
				// Continue toward the package root when an intermediate directory has no manifest.
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Produces a safe argv preview while redacting values following credential-like flags. */
export function summarizeDebugArgs(args: readonly string[]): readonly string[] {
	let redactNext = false;
	return args.map((arg) => {
		const normalized = arg.toLowerCase();
		const isCredentialFlag = /(^|[-_])(token|secret|password|passwd|api[-_]?key|authorization|credential)(=|$)/.test(normalized);
		if (redactNext) {
			redactNext = false;
			return "[REDACTED]";
		}
		if (isCredentialFlag && !arg.includes("=")) {
			redactNext = true;
			return arg;
		}
		if (isCredentialFlag && arg.includes("=")) return `${arg.slice(0, arg.indexOf("=") + 1)}[REDACTED]`;
		return redactDebugText(arg);
	});
}

/** Produces a stable SHA-256 digest and bounded redacted preview for diagnostic text. */
export function summarizeDebugText(value: string, maxLength = MAX_DEBUG_PREVIEW): Record<string, unknown> {
	const redacted = redactDebugText(value);
	return {
		length: value.length,
		sha256: createHash("sha256").update(value).digest("hex"),
		truncated: redacted.length > maxLength,
		preview: redacted.slice(0, maxLength),
	};
}

/** Produces a stable SHA-256 digest for task correlation without persisting task contents. */
export function hashDebugText(value: string | undefined): string | undefined {
	return value === undefined ? undefined : createHash("sha256").update(value).digest("hex");
}

/** Redacts common inline credential forms while retaining useful command diagnostics. */
export function redactDebugText(value: string): string {
	return INLINE_SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, "$1[REDACTED]"), value);
}

/** Recursively removes sensitive keyed values and redacts strings before JSON serialization. */
export function redactDebugValue(value: unknown, key?: string): unknown {
	if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
	if (typeof value === "string") return redactDebugText(value);
	if (Array.isArray(value)) return value.map((item) => redactDebugValue(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redactDebugValue(childValue, childKey)]));
	}
	return value;
}

/** Converts thrown values into stable structured fields for debug events. */
export function debugError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		const candidate = error as Error & { code?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown; args?: unknown };
		return {
			name: error.name,
			message: error.message,
			code: candidate.code,
			signal: candidate.signal,
			args: Array.isArray(candidate.args) ? summarizeDebugArgs(candidate.args.filter((item): item is string => typeof item === "string")) : candidate.args,
			stdout: typeof candidate.stdout === "string" ? summarizeDebugText(candidate.stdout) : candidate.stdout,
			stderr: typeof candidate.stderr === "string" ? summarizeDebugText(candidate.stderr) : candidate.stderr,
		};
	}
	return { message: String(error) };
}
