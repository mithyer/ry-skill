import { isAbsolute } from "node:path";

import type { AgentKind, ResolvedAgentProfile, SessionIdentity } from "./types.ts";

/** Returns the final normal-start argv before any exact-session arguments. */
export function buildNormalAgentArgs(profile: ResolvedAgentProfile): string[] {
	const args = [...profile.modelArgs, ...profile.effortArgs, ...profile.extraArgs];
	validateAgentArgs(args, { allowEmpty: profile.kind === "pi" });
	return args;
}

/** Builds the only supported exact-session continuation arguments for an agent kind. */
export function buildExactResumeArgs(kind: AgentKind, session: SessionIdentity): string[] {
	if (!session.value || session.value.includes("\0")) {
		throw new Error("exact-session resume requires a non-empty session value");
	}
	if (kind === "pi") {
		if (!isAbsolute(session.value)) {
			throw new Error("Pi exact-session resume requires an absolute session path");
		}
		return ["--session", session.value];
	}
	if (kind === "codex") return ["resume", session.value];
	if (kind === "claude") return ["--resume", session.value];
	throw new Error(`Unsupported exact-session agent kind: ${kind}`);
}

/** Builds and validates normal or exact-resume argv immediately before Herdr start. */
export function buildFinalAgentArgs(
	profile: ResolvedAgentProfile,
	exactSession?: SessionIdentity,
): string[] {
	const args = buildNormalAgentArgs(profile);
	if (exactSession) args.push(...buildExactResumeArgs(profile.kind, exactSession));
	validateAgentArgs(args, { allowEmpty: profile.kind === "pi" && exactSession === undefined, exactSession: Boolean(exactSession) });
	return args;
}

/** Rejects values that could turn an argv array into an implicit shell command. */
export function validateAgentArgs(
	args: readonly unknown[],
	options: { allowEmpty: boolean; exactSession?: boolean },
): asserts args is readonly string[] {
	if (!Array.isArray(args)) throw new Error("agentArgs must be an array");
	if (!options.allowEmpty && args.length === 0) throw new Error("agentArgs must be non-empty");
	for (const arg of args) {
		if (typeof arg !== "string") throw new Error("agentArgs must contain only strings");
		if (arg.includes("\0")) throw new Error("agentArgs cannot contain NUL bytes");
		if (/\{(?:model|effort|session|id)\}/.test(arg)) {
			throw new Error(`agentArgs contains an unresolved placeholder: ${arg}`);
		}
	}
	if (args.includes("--last") || args.includes("--continue")) {
		throw new Error("generic latest-session recovery arguments are not valid agentArgs");
	}
	if (options.exactSession && args.filter((arg) => arg === "--session" || arg === "resume" || arg === "--resume").length === 0) {
		throw new Error("exact-session agentArgs are missing a session-specific resume argument");
	}
}

/** Creates a human-readable fallback command without treating it as exact recovery. */
export function formatRecoveryHint(kind: AgentKind, recoveryArgs: readonly string[]): string {
	const command = kind === "codex" ? "codex" : kind === "claude" ? "claude" : "pi";
	return [command, ...recoveryArgs].join(" ");
}
