import type { CompletionContract, SemanticStatus } from "./types.ts";

/** One terminal heading match retained while selecting a coherent final completion block. */
interface HeadingMatch {
	/** Trimmed heading value. */
	value: string;
	/** Match start offset in the captured terminal text. */
	index: number;
	/** Match end offset used as the completion-block anchor. */
	end: number;
}

/** Finds all display-tolerant heading matches in terminal order. */
function readHeadingMatches(text: string, heading: string): HeadingMatch[] {
	const pattern = new RegExp(`^[\\t ]*(?:[^\\r\\n]{1,2})?${heading}\\s*:\\s*(.+?)\\s*$`, "gim");
	return [...text.matchAll(pattern)].flatMap((match) => {
		const value = match[1]?.trim();
		const index = match.index;
		if (!value || index === undefined) return [];
		return [{ value, index, end: index + match[0].length }];
	});
}

/** Reads the first heading after a completion-block anchor. */
function readHeading(text: string, heading: string, startAt = 0): string | undefined {
	return readHeadingMatches(text, heading).find((match) => match.index >= startAt)?.value;
}

/** Normalizes a status heading and rejects statuses outside the runtime contract. */
function readStatus(value: string | undefined): SemanticStatus {
	if (value === "DONE" || value === "BLOCKED" || value === "PARTIAL" || value === "ERROR") return value;
	throw new Error("Child completion contract must contain STATUS: DONE|BLOCKED|PARTIAL|ERROR");
}

/** Parses and validates one coherent completion block after the latest legal STATUS heading. */
export function parseCompletionContract(text: string): CompletionContract {
	const statusMatches = readHeadingMatches(text, "STATUS");
	let statusMatch: HeadingMatch | undefined;
	for (let index = statusMatches.length - 1; index >= 0; index -= 1) {
		try {
			readStatus(statusMatches[index]!.value);
			statusMatch = statusMatches[index];
			break;
		} catch {
			// Relay examples such as STATUS: DONE|BLOCKED|PARTIAL|ERROR are not child results.
		}
	}
	if (!statusMatch) throw new Error("Child completion contract must contain STATUS: DONE|BLOCKED|PARTIAL|ERROR");
	const summary = readHeading(text, "SUMMARY", statusMatch.end);
	const validation = readHeading(text, "VALIDATION", statusMatch.end);
	if (!summary) throw new Error("Child completion contract is missing SUMMARY");
	if (!validation) throw new Error("Child completion contract is missing VALIDATION");
	return {
		status: readStatus(statusMatch.value),
		pipelineStage: readHeading(text, "PIPELINE STAGE", statusMatch.end),
		summary,
		changedFiles: readHeading(text, "CHANGED FILES", statusMatch.end),
		validation,
		risks: readHeading(text, "RISKS / OPEN DECISIONS", statusMatch.end),
		sources: readHeading(text, "SOURCES", statusMatch.end),
		agentSession: readHeading(text, "AGENT SESSION", statusMatch.end),
		recoveryCommand: readHeading(text, "RECOVERY COMMAND", statusMatch.end),
		recoverySemantics: readHeading(text, "RECOVERY SEMANTICS", statusMatch.end),
	};
}

/** Determines whether a parsed contract is sufficient to advance to pane disposition. */
export function isSemanticDone(contract: CompletionContract): boolean {
	return contract.status === "DONE" && Boolean(contract.summary && contract.validation);
}

/** Converts a child output parsing failure into an explicit semantic error contract. */
export function errorCompletionContract(error: unknown): CompletionContract {
	return {
		status: "ERROR",
		summary: error instanceof Error ? error.message : String(error),
		validation: "completion contract parsing failed",
	};
}
