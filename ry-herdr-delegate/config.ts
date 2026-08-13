import type {
	AgentKind,
	AgentProfileConfig,
	DebugLevel,
	DelegateConfig,
	DelegateOverrides,
	ResolvedAgentProfile,
	RoleConfig,
} from "./types.ts";

const DEBUG_LEVELS = new Set<DebugLevel>(["off", "error", "warn", "info", "debug", "trace"]);

/** Validates one configured debug verbosity. */
function readDebugLevel(value: unknown, path: string, fallback: DebugLevel): DebugLevel {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !DEBUG_LEVELS.has(value as DebugLevel)) {
		throw configError(path, "must be off, error, warn, info, debug, or trace");
	}
	return value as DebugLevel;
}

/** Built-in autonomy arguments for the supported autonomous CLI profiles. */
const BUILT_IN_PROFILE_DEFAULTS: Record<AgentKind, AgentProfileConfig> = {
	codex: {
		kind: "codex",
		model: null,
		effort: "high",
		modelArgs: ["--model", "{model}"],
		effortArgs: ["-c", 'model_reasoning_effort="{effort}"'],
		extraArgs: ["--yolo"],
		recoveryArgs: ["resume", "--last"],
		env: {},
	},
	claude: {
		kind: "claude",
		model: null,
		effort: "high",
		modelArgs: ["--model", "{model}"],
		effortArgs: ["--effort", "{effort}"],
		extraArgs: ["--dangerously-skip-permissions"],
		recoveryArgs: ["--continue"],
		env: {},
	},
	pi: {
		kind: "pi",
		model: null,
		effort: "high",
		modelArgs: ["--model", "{model}"],
		effortArgs: ["--thinking", "{effort}"],
		extraArgs: [],
		recoveryArgs: ["--continue"],
		env: {},
	},
};

/** Built-in role defaults used when the configuration omits a role. */
const BUILT_IN_ROLE_DEFAULTS: Record<string, RoleConfig> = {
	delegate: { agent: "pi", effort: "medium" },
	worker: { agent: "codex", effort: "high", timeoutMs: 300000, panePolicy: "new-tab" },
	reviewer: { agent: "claude", timeoutMs: 240000 },
	scout: { agent: "codex", effort: "low" },
	researcher: { agent: "claude" },
	oracle: { agent: "pi", effort: "medium" },
};

/** Valid pane policies accepted by configuration and invocation overrides. */
const PANE_POLICIES = new Set(["close", "keep", "new-tab"]);

/** Valid agent kinds accepted by the Herdr gateway. */
const AGENT_KINDS = new Set<AgentKind>(["codex", "claude", "pi"]);

/** Supported role names accepted by the structured delegate tool. */
const SUPPORTED_ROLES = new Set(["scout", "researcher", "worker", "reviewer", "oracle", "delegate"]);

/** Checks whether a pipeline stage role resolves to a supported built-in or configured role.
 *
 * @param role Candidate stage role name.
 * @returns True when the role is accepted by the runtime configuration boundary.
 */
export function isSupportedRole(role: string): boolean {
	return SUPPORTED_ROLES.has(role);
}

/** Validates a plain optional string field without coercing numbers or objects. */
function readOptionalString(value: unknown, path: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw configError(path, "must be a string or null");
	return value;
}

/** Runtime capability required before profile env may be forwarded to a child. */
export interface ConfigCapabilities {
	/** Whether Herdr child environment propagation has been verified. */
	childEnvVerified: boolean;
}

/** Converts an unknown configuration value into a descriptive validation error. */
function configError(path: string, message: string): Error {
	return new Error(`ry-herdr-delegate config ${path}: ${message}`);
}

/** Requires a plain object instead of accepting arrays or null as configuration maps. */
function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw configError(path, "must be an object");
	}
	return value as Record<string, unknown>;
}

/** Validates a string array while preserving the original argument order. */
function readStringArray(value: unknown, path: string, fallback?: readonly string[]): string[] {
	if (value === undefined) return fallback === undefined ? [] : [...fallback];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw configError(path, "must be an array of strings");
	}
	return [...value];
}

/** Validates an environment map without allowing non-string values. */
function readEnv(value: unknown, path: string, fallback: Readonly<Record<string, string>> = {}): Record<string, string> {
	if (value === undefined) return { ...fallback };
	const record = asRecord(value, path);
	const env: Record<string, string> = {};
	for (const [key, item] of Object.entries(record)) {
		if (!key || typeof item !== "string") {
			throw configError(`${path}.${key || "<empty>"}`, "must contain string values");
		}
		env[key] = item;
	}
	return env;
}

/** Rejects misspelled fields before they can silently change runtime behavior. */
function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) throw configError(`${path}.${key}`, "unknown field");
	}
}

/** Validates a positive integer setting. */
function readPositiveInteger(value: unknown, path: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw configError(path, "must be a positive safe integer");
	}
	return value;
}

/** Validates a supported agent kind. */
function readAgentKind(value: unknown, path: string, fallback: AgentKind): AgentKind {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !AGENT_KINDS.has(value as AgentKind)) {
		throw configError(path, "must be codex, claude, or pi");
	}
	return value as AgentKind;
}

/** Validates a supported pane policy. */
function readPanePolicy(value: unknown, path: string, fallback: "close" | "keep" | "new-tab"): "close" | "keep" | "new-tab" {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !PANE_POLICIES.has(value)) {
		throw configError(path, "must be close, keep, or new-tab");
	}
	return value as "close" | "keep" | "new-tab";
}

/** Parses one agent profile while keeping omitted fields distinguishable from explicit empty arrays. */
function parseAgentProfile(value: unknown, kind: AgentKind): AgentProfileConfig {
	const input = asRecord(value, `agents.${kind}`);
	const builtIn = BUILT_IN_PROFILE_DEFAULTS[kind];
	rejectUnknownKeys(input, ["kind", "model", "effort", "modelArgs", "effortArgs", "extraArgs", "recoveryArgs", "env"], `agents.${kind}`);
	const resolvedKind = readAgentKind(input.kind, `agents.${kind}.kind`, kind);
	if (resolvedKind !== kind) throw configError(`agents.${kind}.kind`, `must match profile name ${kind}`);
	return {
		kind: resolvedKind,
		model: input.model === undefined ? builtIn.model : readOptionalString(input.model, `agents.${kind}.model`),
		effort: input.effort === undefined ? builtIn.effort : readOptionalString(input.effort, `agents.${kind}.effort`),
		modelArgs: readStringArray(input.modelArgs, `agents.${kind}.modelArgs`, builtIn.modelArgs),
		effortArgs: readStringArray(input.effortArgs, `agents.${kind}.effortArgs`, builtIn.effortArgs),
		extraArgs: readStringArray(input.extraArgs, `agents.${kind}.extraArgs`, builtIn.extraArgs),
		recoveryArgs: readStringArray(input.recoveryArgs, `agents.${kind}.recoveryArgs`, builtIn.recoveryArgs),
		env: readEnv(input.env, `agents.${kind}.env`, builtIn.env),
	};
}

/** Parses one role configuration and validates all invocation-facing fields. */
function parseRole(value: unknown, path: string): RoleConfig {
	const input = asRecord(value, path);
	rejectUnknownKeys(input, ["agent", "effort", "extraArgs", "timeoutMs", "panePolicy", "env"], path);
	const effort = readOptionalString(input.effort, `${path}.effort`);
	return {
		agent: readAgentKind(input.agent, `${path}.agent`, "pi"),
		effort,
		extraArgs: input.extraArgs === undefined ? undefined : readStringArray(input.extraArgs, `${path}.extraArgs`),
		timeoutMs: input.timeoutMs === undefined ? undefined : readPositiveInteger(input.timeoutMs, `${path}.timeoutMs`, 1),
		panePolicy: input.panePolicy === undefined ? undefined : readPanePolicy(input.panePolicy, `${path}.panePolicy`, "new-tab"),
		env: input.env === undefined ? undefined : readEnv(input.env, `${path}.env`),
	};
}

/** Parses the JSON configuration and rejects unsupported fields that could hide a typo. */
export function parseDelegateConfig(value: unknown): DelegateConfig {
	const input = asRecord(value, "root");
	rejectUnknownKeys(input, ["version", "defaults", "debug", "agents", "roles", "pipelines"], "root");
	const defaultsInput = asRecord(input.defaults ?? {}, "defaults");
	rejectUnknownKeys(defaultsInput, ["timeoutMs", "panePolicy", "env"], "defaults");
	const debugInput = asRecord(input.debug ?? {}, "debug");
	rejectUnknownKeys(debugInput, ["level", "directory"], "debug");
	if (debugInput.directory !== undefined && (typeof debugInput.directory !== "string" || !debugInput.directory.trim())) throw configError("debug.directory", "must be a non-empty string");
	const agentsInput = asRecord(input.agents ?? {}, "agents");
	for (const profileName of Object.keys(agentsInput)) {
		if (!AGENT_KINDS.has(profileName as AgentKind)) throw configError(`agents.${profileName}`, "unknown profile");
	}
	const rolesInput = asRecord(input.roles ?? {}, "roles");
	for (const roleName of Object.keys(rolesInput)) {
		if (!SUPPORTED_ROLES.has(roleName)) throw configError(`roles.${roleName}`, "unknown role");
	}
	const pipelinesInput = asRecord(input.pipelines ?? {}, "pipelines");
	rejectUnknownKeys(pipelinesInput, ["default"], "pipelines");
	const pipelineDefaultInput = asRecord(pipelinesInput.default ?? {}, "pipelines.default");
	rejectUnknownKeys(pipelineDefaultInput, ["maxStages"], "pipelines.default");
	const maxStages = readPositiveInteger(pipelineDefaultInput.maxStages, "pipelines.default.maxStages", 8);
	if (maxStages > 12) throw configError("pipelines.default.maxStages", "must be no greater than 12");
	const agents = {} as Record<AgentKind, AgentProfileConfig>;
	for (const kind of ["codex", "claude", "pi"] as const) {
		agents[kind] = parseAgentProfile(agentsInput[kind] ?? BUILT_IN_PROFILE_DEFAULTS[kind], kind);
	}
	const roles: Record<string, RoleConfig> = {};
	for (const [role, roleValue] of Object.entries(rolesInput)) {
		roles[role] = parseRole(roleValue, `roles.${role}`);
	}
	return {
		version: input.version === undefined ? 1 : input.version === 1 ? 1 : (() => { throw configError("version", "must be 1"); })(),
		defaults: {
			timeoutMs: readPositiveInteger(defaultsInput.timeoutMs, "defaults.timeoutMs", 180000),
			panePolicy: readPanePolicy(defaultsInput.panePolicy, "defaults.panePolicy", "new-tab"),
			env: readEnv(defaultsInput.env, "defaults.env"),
		},
		debug: {
			level: readDebugLevel(debugInput.level, "debug.level", "off"),
			...(debugInput.directory !== undefined ? { directory: debugInput.directory as string } : {}),
		},
		agents,
		roles,
		pipelines: { default: { maxStages } },
	};
}

/** Returns the selected role, falling back to a built-in role only when it is known. */
function resolveRole(config: DelegateConfig, role: string): RoleConfig {
	const configured = config.roles[role];
	if (configured) return configured;
	const builtIn = BUILT_IN_ROLE_DEFAULTS[role];
	if (!builtIn) throw configError(`roles.${role}`, "role is not configured or supported");
	return builtIn;
}

/** Expands profile placeholders and rejects unresolved values before Herdr is called. */
function expandArguments(values: readonly string[], profile: AgentProfileConfig, effort: string | undefined): string[] {
	return values.map((value) => {
		const expanded = value.replaceAll("{model}", profile.model ?? "").replaceAll("{effort}", effort ?? "");
		if (expanded.includes("{")) throw configError("agentArgs", `unresolved placeholder in ${value}`);
		return expanded;
	});
}

/** Merges environment maps in precedence order without mutating global configuration. */
function mergeEnv(...values: Array<Readonly<Record<string, string>> | undefined>): Record<string, string> {
	return Object.assign({}, ...values.filter((value): value is Readonly<Record<string, string>> => value !== undefined));
}

/** Resolves the effective profile for one role and invocation-local override. */
export function resolveAgentProfile(
	config: DelegateConfig,
	role: string,
	overrides: DelegateOverrides = {},
	capabilities: ConfigCapabilities = { childEnvVerified: false },
): ResolvedAgentProfile {
	const roleConfig = resolveRole(config, role);
	const kind = overrides.agent ?? roleConfig.agent;
	const profile = config.agents[kind] ?? BUILT_IN_PROFILE_DEFAULTS[kind];
	const effort = overrides.effort ?? roleConfig.effort ?? profile.effort ?? undefined;
	const profileEnv = mergeEnv(config.defaults.env, profile.env, roleConfig.env);
	if (Object.keys(profileEnv).length > 0 && !capabilities.childEnvVerified) {
		throw new Error("ry-herdr-delegate capability error: non-empty profile env requires verified Herdr child-env propagation");
	}
	return {
		kind,
		model: profile.model ?? undefined,
		effort,
		modelArgs: profile.model ? expandArguments(profile.modelArgs ?? [], profile, effort) : [],
		effortArgs: effort ? expandArguments(profile.effortArgs ?? [], profile, effort) : [],
		extraArgs: [
			...expandArguments(profile.extraArgs ?? [], profile, effort),
			...expandArguments(roleConfig.extraArgs ?? [], profile, effort),
			...expandArguments(overrides.extraArgs ?? [], profile, effort),
		],
		autonomyEnabled: (profile.extraArgs ?? []).length > 0 || (roleConfig.extraArgs ?? []).length > 0 || (overrides.extraArgs ?? []).length > 0,
		recoveryArgs: [...(profile.recoveryArgs ?? [])],
		timeoutMs: overrides.timeoutMs ?? roleConfig.timeoutMs ?? config.defaults.timeoutMs,
		panePolicy: overrides.panePolicy ?? roleConfig.panePolicy ?? config.defaults.panePolicy,
		env: profileEnv,
	};
}

/** Loads the checked-in example configuration for tests and local development. */
export async function loadDelegateConfig(path: string): Promise<DelegateConfig> {
	const { readFile } = await import("node:fs/promises");
	return parseDelegateConfig(JSON.parse(await readFile(path, "utf8")));
}

/** Built-in profile table exposed for tests without allowing callers to mutate it. */
export function builtInAgentProfiles(): Readonly<Record<AgentKind, AgentProfileConfig>> {
	return structuredClone(BUILT_IN_PROFILE_DEFAULTS);
}
