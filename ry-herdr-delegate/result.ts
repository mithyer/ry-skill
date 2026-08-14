import type { CompletionContract, SemanticStatus } from "./types.ts";

/** Required headings in the child completion contract. */
const REQUIRED_HEADINGS = ["STATUS", "SUMMARY", "VALIDATION"] as const;

/** Extracts a single heading value from raw child terminal output, tolerating indentation and known agent TUI markers. */
function readHeading(text: string, heading: string): string | undefined {
	const pattern = new RegExp(`^[\\t ]*(?:[•⏺]\\s*)?${heading}\\s*:\\s*(.+?)\\s*$`, "im");
	return text.match(pattern)?.[1]?.trim();
}

/** Normalizes a status heading and rejects statuses outside the runtime contract. */
function readStatus(value: string | undefined): SemanticStatus {
	if (value === "DONE" || value === "BLOCKED" || value === "PARTIAL" || value === "ERROR") return value;
	throw new Error("Child completion contract must contain STATUS: DONE|BLOCKED|PARTIAL|ERROR");
}

/** Parses and validates the required child completion contract headings. */
export function parseCompletionContract(text: string): CompletionContract {
	for (const heading of REQUIRED_HEADINGS) {
		if (!readHeading(text, heading)) throw new Error(`Child completion contract is missing ${heading}`);
	}
	return {
		status: readStatus(readHeading(text, "STATUS")),
		pipelineStage: readHeading(text, "PIPELINE STAGE"),
		summary: readHeading(text, "SUMMARY"),
		changedFiles: readHeading(text, "CHANGED FILES"),
		validation: readHeading(text, "VALIDATION"),
		risks: readHeading(text, "RISKS / OPEN DECISIONS"),
		sources: readHeading(text, "SOURCES"),
		agentSession: readHeading(text, "AGENT SESSION"),
		recoveryCommand: readHeading(text, "RECOVERY COMMAND"),
		recoverySemantics: readHeading(text, "RECOVERY SEMANTICS"),
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
