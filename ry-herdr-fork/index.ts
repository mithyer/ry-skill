import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";

import {
	SessionManager,
	UserMessageSelectorComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

import {
	launchSessionInHerdr,
	type CommandExecutor as SharedCommandExecutor,
	type HerdrSessionLaunchDependencies,
	type HerdrSessionLaunchResult,
} from "../shared/herdr-session-launch.ts";
import { persistDeferredSession } from "../shared/pi-session.ts";

/** The skill command intercepted before Pi expands it into a user message. */
const SKILL_INVOCATION = "/skill:ry-herdr-fork";

/** A selectable user message and the location immediately before it. */
export interface ForkCandidate {
	/** Session entry identifier for the user message. */
	entryId: string;
	/** Text Pi will restore into the new tab's editor. */
	text: string;
	/** Entry identifier copied as the fork's final history item, or null for an empty history. */
	parentId: string | null;
}

/** The new Pi session prepared without modifying the source session. */
export interface PreparedFork {
	/** Absolute path to the independently persisted fork session. */
	sessionFile: string;
	/** Original selected prompt to place in the new Pi editor. */
	prompt: string;
}

/** Identifiers returned after Herdr successfully starts the forked Pi process. */
export type HerdrForkResult = HerdrSessionLaunchResult;

/** Command runner compatible with Pi's extension-level exec API. */
export type CommandExecutor = SharedCommandExecutor;

/** Inputs required to create a Herdr tab and open the prepared fork. */
export interface HerdrLaunchRequest {
	/** Working directory inherited by the new tab and Pi process. */
	cwd: string;
	/** Forked session file opened with `pi --session`. */
	sessionFile: string;
	/** Selected user message restored into the new Pi editor without submitting it. */
	prompt: string;
}

/** Optional launch dependencies used to isolate Herdr CLI behavior in tests. */
export type HerdrLaunchDependencies = HerdrSessionLaunchDependencies;

/**
 * Extracts the text content Pi restores when forking before a user message.
 *
 * @param entry User-message session entry selected by the user.
 * @returns Concatenated text blocks, matching Pi's built-in `/fork` behavior.
 */
function extractUserMessageText(entry: SessionMessageEntry): string {
	if (entry.message.role !== "user") {
		return "";
	}

	const { content } = entry.message;
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/**
 * Lists the same user-message choices exposed by Pi's built-in fork selector.
 *
 * @param entries Session entries in append order.
 * @returns Selectable user messages, including their pre-message fork locations.
 * TEST:index.test.ts[extractForkCandidates mirrors Pi user-message selection]
 */
export function extractForkCandidates(entries: readonly SessionEntry[]): ForkCandidate[] {
	const candidates: ForkCandidate[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") {
			continue;
		}

		const text = extractUserMessageText(entry);
		if (text) {
			candidates.push({ entryId: entry.id, text, parentId: entry.parentId });
		}
	}
	return candidates;
}

/**
 * Creates a standalone session ending immediately before the selected user message.
 * The source manager is treated as read-only; a separately opened manager performs
 * Pi's native branch extraction so the current tab and source leaf remain unchanged.
 *
 * @param source Read-only manager for the current Pi session.
 * @param selectedEntryId User-message entry selected in the fork picker.
 * @returns The persisted fork path and prompt to restore in the new editor.
 * TEST:index.test.ts[createForkSession truncates before selected message without changing source]
 * TEST:index.test.ts[createForkSession supports forking before the root message]
 */
export async function createForkSession(
	source: ExtensionContext["sessionManager"],
	selectedEntryId: string,
): Promise<PreparedFork> {
	const sourceFile = source.getSessionFile();
	if (!sourceFile || !existsSync(sourceFile)) {
		throw new Error("This session has not been saved yet. Wait for the first assistant response before forking it.");
	}

	const selectedEntry = source.getEntry(selectedEntryId);
	if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
		throw new Error("The selected fork entry is not a user message");
	}

	const prompt = extractUserMessageText(selectedEntry);
	if (!prompt) {
		throw new Error("The selected user message has no text to restore");
	}

	const sessionDir = source.getSessionDir();
	const cwd = source.getCwd();
	let forkManager: SessionManager;
	let sessionFile: string | undefined;

	if (selectedEntry.parentId) {
		// Open a separate manager and let Pi copy/re-chain the exact path through
		// the selected message's parent. The live source manager is never branched.
		forkManager = SessionManager.open(sourceFile, sessionDir, cwd);
		sessionFile = forkManager.createBranchedSession(selectedEntry.parentId);
	} else {
		// Selecting the root user message means the new session contains only a
		// header whose parent points back to the current session.
		forkManager = SessionManager.create(cwd, sessionDir, { parentSession: sourceFile });
		sessionFile = forkManager.getSessionFile();
	}

	if (!sessionFile) {
		throw new Error("Pi did not create a persisted fork session");
	}

	await persistDeferredSession(forkManager, sessionFile);
	return { sessionFile, prompt };
}

/**
 * Opens a Herdr tab, starts Pi on a prepared partial session, and restores the
 * selected prompt into the new editor without pressing Enter.
 *
 * @param request Working directory, session path, and editor prompt.
 * @param dependencies Command runner and overridable environment/test helpers.
 * @returns Herdr tab, pane, agent, and session identifiers.
 * TEST:index.test.ts[launchForkInHerdr opens partial session and restores editor text]
 * TEST:index.test.ts[launchForkInHerdr retries a newly created busy pane]
 * TEST:index.test.ts[launchForkInHerdr closes its tab when startup fails]
 */
export async function launchForkInHerdr(
	request: HerdrLaunchRequest,
	dependencies: HerdrLaunchDependencies,
): Promise<HerdrForkResult> {
	return launchSessionInHerdr(
		{
			cwd: request.cwd,
			sessionFile: request.sessionFile,
			labelPrefix: "fork",
			editorText: request.prompt,
		},
		dependencies,
	);
}

/**
 * Displays Pi's own user-message selector and returns the chosen entry.
 *
 * @param ctx Active extension context with TUI access.
 * @param candidates User messages available for forking.
 * @returns Selected entry ID, or undefined when the picker is cancelled.
 */
async function selectForkEntry(
	ctx: ExtensionContext,
	candidates: readonly ForkCandidate[],
): Promise<string | undefined> {
	const initialSelectedId = candidates.at(-1)?.entryId;
	return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
		const selector = new UserMessageSelectorComponent(
			candidates.map((candidate) => ({ id: candidate.entryId, text: candidate.text })),
			(entryId) => done(entryId),
			() => done(undefined),
			initialSelectedId,
		);
		const messageList = selector.getMessageList();

		// Extension custom UI focuses the returned wrapper, so forward input to
		// Pi's internal message-list component exactly as the built-in `/fork` UI does.
		return {
			render: (width: number) => selector.render(width),
			invalidate: () => selector.invalidate(),
			handleInput: (data: string) => {
				messageList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/**
 * Runs the complete no-history fork flow for a command or intercepted skill invocation.
 *
 * @param ctx Current Pi extension context.
 * @param execute Command executor used for Herdr CLI calls.
 * @returns The created Herdr identifiers, or undefined when the user cancels.
 */
async function runForkFlow(
	ctx: ExtensionContext,
	execute: CommandExecutor,
): Promise<HerdrForkResult | undefined> {
	if (ctx.mode !== "tui") {
		throw new Error("ry-herdr-fork requires Pi interactive mode");
	}

	const candidates = extractForkCandidates(ctx.sessionManager.getEntries());
	if (candidates.length === 0) {
		throw new Error("No user messages are available to fork from");
	}

	const selectedEntryId = await selectForkEntry(ctx, candidates);
	if (!selectedEntryId) {
		return undefined;
	}

	const prepared = await createForkSession(ctx.sessionManager, selectedEntryId);
	try {
		return await launchForkInHerdr(
			{ cwd: ctx.cwd, sessionFile: prepared.sessionFile, prompt: prepared.prompt },
			{ execute },
		);
	} catch (error) {
		// The fork file belongs only to this launch attempt and must not remain
		// when Herdr rolls back the new tab.
		await unlink(prepared.sessionFile).catch(() => undefined);
		throw error;
	}
}

/**
 * Formats unknown failures for ephemeral TUI notifications.
 *
 * @param error Unknown value thrown by the fork flow.
 * @returns Human-readable error text.
 */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Registers zero-history `/herdr-fork` and `/skill:ry-herdr-fork` entrypoints.
 *
 * @param pi Pi extension API used for command registration and process execution.
 * @returns Nothing.
 */
export default function ryHerdrFork(pi: ExtensionAPI): void {
	let forkInProgress = false;
	const execute: CommandExecutor = (command, args, options) => pi.exec(command, args, options);

	/** Runs one serialized fork request and reports only non-persistent TUI feedback. */
	const startFork = async (ctx: ExtensionContext): Promise<void> => {
		if (forkInProgress) {
			ctx.ui.notify("A Herdr fork picker is already open", "warning");
			return;
		}

		forkInProgress = true;
		try {
			const result = await runForkFlow(ctx, execute);
			if (result) {
				ctx.ui.notify(`Fork opened in ${result.tab} (${result.pane}, ${result.agent})`, "info");
			}
		} catch (error) {
			ctx.ui.notify(`ry-herdr-fork: ${formatError(error)}`, "error");
		} finally {
			forkInProgress = false;
		}
	};

	pi.registerCommand("herdr-fork", {
		description: "Fork from an earlier user message into a new Herdr tab without changing this session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await startFork(ctx);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.text.trim() !== SKILL_INVOCATION) {
			return;
		}

		// Input handlers run before skill expansion and before the user message is
		// persisted. Returning `handled` is what keeps the invocation out of JSONL.
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current Pi turn to finish, then run the fork again", "warning");
			return { action: "handled" as const };
		}

		await startFork(ctx);
		return { action: "handled" as const };
	});
}
