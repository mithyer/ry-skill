import { randomUUID } from "node:crypto";

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

/** Maximum number of short retries while a newly created Herdr pane becomes available. */
const AGENT_START_ATTEMPTS = 30;

/** Delay between Herdr pane-busy retries. */
const AGENT_START_RETRY_MS = 100;

/** Command runner compatible with Pi's extension-level exec API. */
export type CommandExecutor = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** Inputs required to create a Herdr tab and open a prepared Pi session. */
export interface HerdrSessionLaunchRequest {
	/** Working directory inherited by the new tab and Pi process. */
	cwd: string;
	/** Prepared session file opened with `pi --session`. */
	sessionFile: string;
	/** Short operation name used in the tab label and agent name. */
	labelPrefix: string;
	/** Optional text restored into the new Pi editor without submitting it. */
	editorText?: string;
}

/** Optional launch dependencies used to isolate Herdr CLI behavior in tests. */
export interface HerdrSessionLaunchDependencies {
	/** Command executor, normally `pi.exec`. */
	execute: CommandExecutor;
	/** Environment containing the current Herdr workspace and pane identifiers. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Clock used to create a readable tab label. */
	now?: () => Date;
	/** Short unique suffix used to avoid live Herdr agent-name collisions. */
	uniqueSuffix?: () => string;
	/** Retry delay implementation. */
	sleep?: (milliseconds: number) => Promise<void>;
}

/** Identifiers returned after Herdr successfully starts the new Pi process. */
export interface HerdrSessionLaunchResult {
	/** Identifier of the newly created Herdr tab. */
	tab: string;
	/** Identifier of the new tab's root pane. */
	pane: string;
	/** Unique Herdr agent name assigned to the new Pi process. */
	agent: string;
	/** Absolute path to the prepared Pi session opened in the new tab. */
	session: string;
}

/**
 * Reads a required string from a Herdr JSON response.
 *
 * @param output Herdr CLI JSON output.
 * @param path Object-property path containing the expected identifier.
 * @returns The non-empty identifier at the requested path.
 */
function readHerdrIdentifier(output: string, path: readonly string[]): string {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error(`Herdr returned invalid JSON: ${output.trim() || "<empty output>"}`);
	}

	for (const key of path) {
		if (!value || typeof value !== "object" || !(key in value)) {
			throw new Error(`Herdr response is missing ${path.join(".")}`);
		}
		value = (value as Record<string, unknown>)[key];
	}

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Herdr response contains an invalid ${path.join(".")}`);
	}
	return value;
}

/**
 * Converts a failed command result into a concise actionable error.
 *
 * @param command Human-readable command label.
 * @param result Failed process result.
 * @returns Error containing stderr, stdout, or the exit status.
 */
function commandFailure(command: string, result: ExecResult): Error {
	const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
	return new Error(`${command} failed: ${detail}`);
}

/**
 * Opens a background Herdr tab and starts Pi on a prepared independent session.
 * Optional editor text is injected literally without pressing Enter.
 *
 * @param request Working directory, session path, label prefix, and optional editor text.
 * @param dependencies Command runner and overridable environment/test helpers.
 * @returns Herdr tab, pane, agent, and session identifiers.
 * TEST:../ry-herdr-fork/index.test.ts[launchForkInHerdr opens partial session and restores editor text]
 * TEST:../ry-herdr-fork/index.test.ts[launchForkInHerdr retries a newly created busy pane]
 * TEST:../ry-herdr-fork/index.test.ts[launchForkInHerdr closes its tab when startup fails]
 * TEST:../ry-herdr-clone/index.test.ts[launchCloneInHerdr opens the clone with an empty editor]
 */
export async function launchSessionInHerdr(
	request: HerdrSessionLaunchRequest,
	dependencies: HerdrSessionLaunchDependencies,
): Promise<HerdrSessionLaunchResult> {
	const env = dependencies.env ?? process.env;
	const now = dependencies.now ?? (() => new Date());
	const uniqueSuffix = dependencies.uniqueSuffix ?? (() => randomUUID().slice(0, 6));
	const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

	if (env.HERDR_ENV !== "1" || !env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID) {
		throw new Error("Pi is not running inside a Herdr-managed pane");
	}

	const timestamp = now().toTimeString().slice(0, 8).replaceAll(":", "");
	const tabLabel = `${request.labelPrefix}-${timestamp}`;
	const agentName = `${tabLabel}-${uniqueSuffix()}`;
	let createdTabId: string | undefined;

	try {
		const tabResult = await dependencies.execute(
			"herdr",
			[
				"tab",
				"create",
				"--workspace",
				env.HERDR_WORKSPACE_ID,
				"--cwd",
				request.cwd,
				"--label",
				tabLabel,
				"--no-focus",
			],
			{ cwd: request.cwd, timeout: 10_000 },
		);
		if (tabResult.code !== 0) {
			throw commandFailure("herdr tab create", tabResult);
		}

		createdTabId = readHerdrIdentifier(tabResult.stdout, ["result", "tab", "tab_id"]);
		const paneId = readHerdrIdentifier(tabResult.stdout, ["result", "root_pane", "pane_id"]);

		let startResult: ExecResult | undefined;
		for (let attempt = 0; attempt < AGENT_START_ATTEMPTS; attempt++) {
			startResult = await dependencies.execute(
				"herdr",
				[
					"agent",
					"start",
					agentName,
					"--kind",
					"pi",
					"--pane",
					paneId,
					"--",
					"--session",
					request.sessionFile,
					"--name",
					tabLabel,
				],
				{ cwd: request.cwd, timeout: 35_000 },
			);

			if (startResult.code === 0) {
				break;
			}

			const failureOutput = `${startResult.stdout}\n${startResult.stderr}`;
			if (!failureOutput.includes('"code":"agent_pane_busy"')) {
				throw commandFailure("herdr agent start", startResult);
			}
			await sleep(AGENT_START_RETRY_MS);
		}

		if (!startResult || startResult.code !== 0) {
			throw new Error(`New pane ${paneId} did not become ready within 3 seconds`);
		}

		if (request.editorText !== undefined) {
			// `agent start` waits until Pi is ready. Raw pane text intentionally omits
			// Enter, leaving the restored text editable just like Pi's native `/fork`.
			const editorResult = await dependencies.execute(
				"herdr",
				["pane", "send-text", paneId, "--", request.editorText],
				{ cwd: request.cwd, timeout: 10_000 },
			);
			if (editorResult.code !== 0) {
				throw commandFailure("herdr pane send-text", editorResult);
			}
		}

		return {
			tab: createdTabId,
			pane: paneId,
			agent: agentName,
			session: request.sessionFile,
		};
	} catch (error) {
		if (createdTabId) {
			// Cleanup is best-effort; preserve the original startup error.
			await dependencies.execute("herdr", ["tab", "close", createdTabId], {
				cwd: request.cwd,
				timeout: 5_000,
			}).catch(() => undefined);
		}
		throw error;
	}
}
