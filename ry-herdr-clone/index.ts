import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";

import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	launchSessionInHerdr,
	type CommandExecutor as SharedCommandExecutor,
	type HerdrSessionLaunchDependencies,
	type HerdrSessionLaunchResult,
} from "../shared/herdr-session-launch.ts";
import { persistDeferredSession } from "../shared/pi-session.ts";

/** The skill command intercepted before Pi expands it into a user message. */
const SKILL_INVOCATION = "/skill:ry-herdr-clone";

/** The independently persisted copy of the current active branch. */
export interface PreparedClone {
	/** Absolute path to the cloned Pi session. */
	sessionFile: string;
}

/** Identifiers returned after Herdr successfully starts the cloned Pi process. */
export type HerdrCloneResult = HerdrSessionLaunchResult;

/** Command runner compatible with Pi's extension-level exec API. */
export type CommandExecutor = SharedCommandExecutor;

/** Inputs required to create a Herdr tab and open the prepared clone. */
export interface HerdrCloneLaunchRequest {
	/** Working directory inherited by the new tab and Pi process. */
	cwd: string;
	/** Cloned session file opened with `pi --session`. */
	sessionFile: string;
}

/** Optional launch dependencies used to isolate Herdr CLI behavior in tests. */
export type HerdrCloneLaunchDependencies = HerdrSessionLaunchDependencies;

/**
 * Copies the source session's current active path through its leaf into a new
 * session file. A separate mutable manager protects the live source manager.
 *
 * @param source Read-only manager for the current Pi session.
 * @returns The independently persisted clone session path.
 * TEST:index.test.ts[createCloneSession copies only the active branch without changing source]
 * TEST:index.test.ts[createCloneSession persists an active branch without an assistant]
 * TEST:index.test.ts[createCloneSession rejects a session without a current entry]
 */
export async function createCloneSession(source: ExtensionContext["sessionManager"]): Promise<PreparedClone> {
	const leafId = source.getLeafId();
	if (!leafId) {
		throw new Error("Nothing to clone yet");
	}

	const sourceFile = source.getSessionFile();
	if (!sourceFile || !existsSync(sourceFile)) {
		throw new Error("This session has not been saved yet. Wait for the first assistant response before cloning it.");
	}

	// Pi's native `/clone` is `fork(leafId, { position: "at" })`. Opening
	// the file in another manager applies that extraction without replacing
	// the runtime or leaf in the current tab.
	const cloneManager = SessionManager.open(sourceFile, source.getSessionDir(), source.getCwd());
	const sessionFile = cloneManager.createBranchedSession(leafId);
	if (!sessionFile) {
		throw new Error("Pi did not create a persisted clone session");
	}

	await persistDeferredSession(cloneManager, sessionFile);
	return { sessionFile };
}

/**
 * Opens a new Herdr tab on the prepared clone and intentionally leaves its Pi
 * editor empty, matching native `/clone` behavior.
 *
 * @param request Working directory and cloned session path.
 * @param dependencies Command runner and overridable environment/test helpers.
 * @returns Herdr tab, pane, agent, and session identifiers.
 * TEST:index.test.ts[launchCloneInHerdr opens the clone with an empty editor]
 */
export async function launchCloneInHerdr(
	request: HerdrCloneLaunchRequest,
	dependencies: HerdrCloneLaunchDependencies,
): Promise<HerdrCloneResult> {
	return launchSessionInHerdr(
		{
			cwd: request.cwd,
			sessionFile: request.sessionFile,
			labelPrefix: "clone",
		},
		dependencies,
	);
}

/**
 * Runs the complete no-history clone flow for a command or intercepted skill invocation.
 *
 * @param ctx Current Pi extension context.
 * @param execute Command executor used for Herdr CLI calls.
 * @returns The created Herdr identifiers.
 * TEST:index.test.ts[runCloneFlow removes the clone file when Herdr startup fails]
 */
export async function runCloneFlow(ctx: ExtensionContext, execute: CommandExecutor): Promise<HerdrCloneResult> {
	if (ctx.mode !== "tui") {
		throw new Error("ry-herdr-clone requires Pi interactive mode");
	}

	const prepared = await createCloneSession(ctx.sessionManager);
	try {
		return await launchCloneInHerdr(
			{ cwd: ctx.cwd, sessionFile: prepared.sessionFile },
			{ execute },
		);
	} catch (error) {
		// The clone file belongs only to this launch attempt and must not remain
		// when the shared Herdr launcher rolls back its new tab.
		await unlink(prepared.sessionFile).catch(() => undefined);
		throw error;
	}
}

/**
 * Formats unknown failures for ephemeral TUI notifications.
 *
 * @param error Unknown value thrown by the clone flow.
 * @returns Human-readable error text.
 */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Registers zero-history `/herdr-clone` and `/skill:ry-herdr-clone` entrypoints.
 *
 * @param pi Pi extension API used for command registration and process execution.
 * @returns Nothing.
 * TEST:index.test.ts[ryHerdrClone intercepts its skill invocation while busy]
 */
export default function ryHerdrClone(pi: ExtensionAPI): void {
	let cloneInProgress = false;
	const execute: CommandExecutor = (command, args, options) => pi.exec(command, args, options);

	/** Runs one serialized clone request and reports only non-persistent TUI feedback. */
	const startClone = async (ctx: ExtensionContext): Promise<void> => {
		if (cloneInProgress) {
			ctx.ui.notify("A Herdr clone is already being created", "warning");
			return;
		}

		cloneInProgress = true;
		try {
			const result = await runCloneFlow(ctx, execute);
			ctx.ui.notify(`Clone opened in ${result.tab} (${result.pane}, ${result.agent})`, "info");
		} catch (error) {
			ctx.ui.notify(`ry-herdr-clone: ${formatError(error)}`, "error");
		} finally {
			cloneInProgress = false;
		}
	};

	pi.registerCommand("herdr-clone", {
		description: "Clone the current active branch into a new Herdr tab without changing this session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await startClone(ctx);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.text.trim() !== SKILL_INVOCATION) {
			return;
		}

		// Input handlers run before skill expansion and before the user message is
		// persisted. Returning `handled` keeps this invocation out of JSONL.
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current Pi turn to finish, then run the clone again", "warning");
			return { action: "handled" as const };
		}

		await startClone(ctx);
		return { action: "handled" as const };
	});
}
