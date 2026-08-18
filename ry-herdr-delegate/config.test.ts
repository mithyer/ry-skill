import assert from "node:assert/strict";
import test from "node:test";

import { buildExactResumeArgs, buildFinalAgentArgs, validateAgentArgs } from "./args.ts";
import { builtInAgentProfiles, parseDelegateConfig, resolveAgentProfile } from "./config.ts";

/** Checks built-in autonomous profile expansion and explicit role override precedence. */
test("configuration resolves built-in worker profile and autonomy args", () => {
	const config = parseDelegateConfig({ version: 1 });
	const profile = resolveAgentProfile(config, "worker");
	assert.equal(profile.kind, "codex");
	assert.equal(profile.effort, "high");
	assert.deepEqual(profile.modelArgs, []);
	assert.deepEqual(profile.effortArgs, ['-c', 'model_reasoning_effort="high"']);
	assert.deepEqual(profile.extraArgs, ["--yolo"]);
	assert.deepEqual(buildFinalAgentArgs(profile), ['-c', 'model_reasoning_effort="high"', "--yolo"]);
});

/** Checks explicit empty extraArgs disables profile autonomy without changing global defaults. */
test("configuration preserves explicit autonomy opt-out", () => {
	const config = parseDelegateConfig({
		version: 1,
		agents: { codex: { extraArgs: [] } },
	});
	const profile = resolveAgentProfile(config, "worker");
	assert.deepEqual(profile.extraArgs, []);
});

/** Verifies model precedence and `{model}` expansion for role and invocation overrides. */
test("configuration resolves role and invocation model overrides", () => {
	const config = parseDelegateConfig({
		version: 2,
		agents: {
			codex: {
				model: "profile-model",
				modelArgs: ["--model", "{model}"],
			},
		},
		roles: {
			scout: {
				agent: "codex",
				model: "role-model",
			},
		},
	});
	const roleProfile = resolveAgentProfile(config, "scout");
	assert.equal(roleProfile.model, "role-model");
	assert.deepEqual(roleProfile.modelArgs, ["--model", "role-model"]);
	const invocationProfile = resolveAgentProfile(config, "scout", { model: "invocation-model" });
	assert.equal(invocationProfile.model, "invocation-model");
	assert.deepEqual(invocationProfile.modelArgs, ["--model", "invocation-model"]);
});

/** Checks unknown fields and unsupported roles fail before a gateway call. */
test("configuration rejects typos and unsupported roles", () => {
	assert.throws(() => parseDelegateConfig({ version: 1, defaults: { panePolciy: "keep" } }), /unknown field/);
	assert.throws(() => parseDelegateConfig({ version: 1, roles: { unknown: { agent: "pi" } } }), /unknown role/);
	assert.throws(() => parseDelegateConfig({ version: 1, debug: { enabled: true } }), /unknown field/);
	assert.throws(() => parseDelegateConfig({ version: 1, debug: { file: "shared.jsonl" } }), /unknown field/);
	assert.throws(() => resolveAgentProfile(parseDelegateConfig({ version: 1 }), "unknown"), /not configured or supported/);
});

/** Checks debug verbosity uses a strict level field and fails closed for legacy shared-log keys. */
test("configuration parses debug levels and rejects legacy debug keys", () => {
	assert.equal(parseDelegateConfig({ version: 1 }).debug.level, "off");
	assert.deepEqual(parseDelegateConfig({ version: 1, debug: { level: "trace", directory: ".pi/debug" } }).debug, { level: "trace", directory: ".pi/debug" });
	assert.throws(() => parseDelegateConfig({ version: 1, debug: { level: "verbose" } }), /must be off, error, warn, info, debug, or trace/);
	assert.throws(() => parseDelegateConfig({ version: 1, debug: { enabled: true } }), /unknown field/);
	assert.throws(() => parseDelegateConfig({ version: 1, debug: { file: "shared.jsonl" } }), /unknown field/);
});

test("exact resume args are agent-specific", () => {
	assert.deepEqual(buildExactResumeArgs("pi", { kind: "path", source: "herdr:pi", value: "/tmp/child.jsonl" }), ["--session", "/tmp/child.jsonl"]);
	assert.deepEqual(buildExactResumeArgs("codex", { kind: "id", source: "herdr:codex", value: "codex-session" }), ["resume", "codex-session"]);
	assert.deepEqual(buildExactResumeArgs("claude", { kind: "id", source: "herdr:claude", value: "claude-session" }), ["--resume", "claude-session"]);
});

/** Checks generic latest-session recovery is never accepted as exact agentArgs. */
test("agentArgs rejects generic recovery and unresolved placeholders", () => {
	assert.throws(() => validateAgentArgs(["--continue"], { allowEmpty: false }), /latest-session/);
	assert.throws(() => validateAgentArgs(["--model", "{model}"], { allowEmpty: false }), /unresolved placeholder/);
	assert.throws(() => validateAgentArgs([], { allowEmpty: false }), /non-empty/);
});

/** Checks built-in profile snapshots cannot mutate the next resolution. */
test("built-in profiles are returned as defensive copies", () => {
	const profiles = builtInAgentProfiles();
	(profiles.codex.extraArgs as string[]).push("--changed");
	assert.deepEqual(builtInAgentProfiles().codex.extraArgs, ["--yolo"]);
});
