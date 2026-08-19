import { redactSensitivePayload } from "./records.ts";
import type { RelayTransport } from "./types.ts";

/** Direct relay transport identifier persisted in new task, continuation, and control payloads. */
export const DIRECT_RELAY_TRANSPORT: RelayTransport = "herdr-direct-v2";

/** Legacy relay transport inferred for events that predate the transport field. */
export const LEGACY_RELAY_TRANSPORT: RelayTransport = "pointer-v1";

/** Maximum UTF-8 size accepted for one direct Herdr argv prompt. */
export const MAX_DIRECT_RELAY_BYTES = 64 * 1024;

/** Maximum newline-delimited lines accepted for one direct Herdr prompt. */
export const MAX_DIRECT_RELAY_LINES = 400;

/** Additional terminal lines requested beyond the direct prompt echo. */
export const DIRECT_RELAY_READ_MARGIN_LINES = 128;

/** Identity used to select a current relay from terminal or Pi session output. */
export interface RelayAnchorContext {
	/** Persisted transport version for the relay being observed. */
	transport: RelayTransport;
	/** Legacy event-log path retained for pointer-v1 matching. */
	communicationFile: string;
	/** Parent-generated message identity. */
	relayMessageId: string;
}

/** Input used to render one complete direct prompt. */
export interface DirectRelayPromptInput {
	/** Parent-generated relay identity. */
	messageId: string;
	/** Human-readable task, continuation, or coordinator message type. */
	messageType: string;
	/** Structured payload that will also be persisted in the event log. */
	payload: Record<string, unknown>;
	/** Additional role-specific instructions appended before the completion contract. */
	instructions?: readonly string[];
}

/** Rendered prompt and bounded transport metadata used by the monitor. */
export interface BuiltDirectRelayPrompt {
	/** Complete prompt text sent to Herdr. */
	text: string;
	/** Redacted payload serialized into the prompt and event audit. */
	payload: Record<string, unknown>;
	/** UTF-8 byte length of the prompt. */
	byteLength: number;
	/** Newline-delimited line count of the prompt. */
	lineCount: number;
}

/** Structured validation failure that must become a BLOCKED result before pane creation.
 * TEST:relay.test.ts[direct relay prompt rejects oversized and credential-shaped payloads]
 */
export class RelayPromptValidationError extends Error {
	/** Stable validation classification for tests and debug output. */
	readonly code: "INVALID_IDENTITY" | "PROMPT_TOO_LARGE" | "PROMPT_TOO_MANY_LINES" | "PROMPT_SENSITIVE_VALUE" | "PROMPT_SERIALIZATION";

	/**
	 * Creates a direct prompt validation failure.
	 *
	 * @param code Stable validation classification.
	 * @param message Human-readable failure detail.
	 */
	constructor(code: RelayPromptValidationError["code"], message: string) {
		super(message);
		this.name = "RelayPromptValidationError";
		this.code = code;
	}
}

/** Finds a marker while tolerating terminal-inserted whitespace and line wrapping. */
function findMarker(text: string, label: string, value: string): number {
	const compact = `${label}:${value}`.replace(/\s+/g, "");
	const pattern = [...compact].map((character) => `${character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`).join("");
	// Require whitespace or end-of-text after the expected value so a foreign prefix cannot satisfy an anchor.
	return text.search(new RegExp(`${pattern}(?!\\S)`, "i"));
}

/** Returns whether a relay identity field can be safely rendered on one prompt line. */
function isSafeLineValue(value: string): boolean {
	return value.length > 0 && !/[\r\n]/.test(value);
}

/** Detects common credential-shaped text that key-based object redaction cannot see. */
function containsSensitiveText(text: string): boolean {
	return /(?:password|token|secret|cookie|private[\s_-]*key|api[\s_-]*key|authorization)\s*[:=]\s*["']?[^\s"',;]+/i.test(text)
		|| /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/.test(text);
}

/** Redacts object-key secrets and validates that the resulting payload has record shape. */
function normalizePromptPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const redacted = redactSensitivePayload(payload);
	if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) {
		throw new RelayPromptValidationError("PROMPT_SERIALIZATION", "direct relay payload must serialize as an object");
	}
	return redacted as Record<string, unknown>;
}

/** Validates prompt size, line count, serialization and content before external delivery.
 * TEST:relay.test.ts[direct relay prompt rejects a prompt over the line bound]
 */
export function inspectDirectRelayPrompt(text: string): { byteLength: number; lineCount: number } {
	const byteLength = Buffer.byteLength(text, "utf8");
	const lineCount = text.split("\n").length;
	if (byteLength > MAX_DIRECT_RELAY_BYTES) {
		throw new RelayPromptValidationError("PROMPT_TOO_LARGE", `direct relay prompt exceeds ${MAX_DIRECT_RELAY_BYTES} UTF-8 bytes`);
	}
	if (lineCount > MAX_DIRECT_RELAY_LINES) {
		throw new RelayPromptValidationError("PROMPT_TOO_MANY_LINES", `direct relay prompt exceeds ${MAX_DIRECT_RELAY_LINES} lines`);
	}
	if (containsSensitiveText(text)) {
		throw new RelayPromptValidationError("PROMPT_SENSITIVE_VALUE", "direct relay prompt contains credential-shaped text");
	}
	return { byteLength, lineCount };
}

/**
 * Builds the complete direct-v2 prompt from the normalized event payload.
 *
 * @param input Relay identity, message type, durable payload, and optional role instructions.
 * @returns Redacted prompt and bounded transport metadata.
 * TEST:relay.test.ts[direct relay prompt carries a complete payload without pointer markers]
 */
export function buildDirectRelayPrompt(input: DirectRelayPromptInput): BuiltDirectRelayPrompt {
	if (!isSafeLineValue(input.messageId) || !isSafeLineValue(input.messageType)) {
		throw new RelayPromptValidationError("INVALID_IDENTITY", "direct relay identity contains a newline or is empty");
	}
	// The builder owns the transport identity so the payload cannot disagree with its direct-v2 header.
	const payload = { ...normalizePromptPayload(input.payload), relayTransport: DIRECT_RELAY_TRANSPORT };
	let payloadJson: string;
	try {
		payloadJson = JSON.stringify(payload);
	} catch (error) {
		throw new RelayPromptValidationError("PROMPT_SERIALIZATION", error instanceof Error ? error.message : String(error));
	}
	if (!payloadJson) throw new RelayPromptValidationError("PROMPT_SERIALIZATION", "direct relay payload serialized to an empty value");
	const instructions = input.instructions ?? ["Do not delegate recursively."];
	const text = [
		`RELAY TRANSPORT: ${DIRECT_RELAY_TRANSPORT}`,
		`MESSAGE ID: ${input.messageId}`,
		`MESSAGE TYPE: ${input.messageType}`,
		"RELAY PAYLOAD JSON:",
		payloadJson,
		"",
		"Execute the complete task described by the relay payload.",
		"Do not read or modify communication JSONL; the parent/coordinator owns durable state and recovery.",
		...instructions,
		"Return exactly these three headings, each on its own line:",
		"STATUS: DONE|BLOCKED|PARTIAL|ERROR",
		"SUMMARY: <one-line result>",
		"VALIDATION: <commands or checks performed>",
		"Use STATUS: DONE only when the task is complete and validated.",
	].join("\n");
	const metrics = inspectDirectRelayPrompt(text);
	return { text, payload, ...metrics };
}

/** Resolves the persisted transport field, treating absent fields as legacy pointer-v1.
 * TEST:relay.test.ts[relay anchors select direct-v2 and legacy pointer-v1 independently]
 */
export function relayTransportFromPayload(payload: Record<string, unknown>): RelayTransport {
	const value = payload.relayTransport;
	if (value === undefined) return LEGACY_RELAY_TRANSPORT;
	if (value === DIRECT_RELAY_TRANSPORT) return DIRECT_RELAY_TRANSPORT;
	throw new Error(`unsupported relayTransport: ${String(value)}`);
}

/** Returns whether terminal/session text contains the expected versioned relay identity.
 * TEST:relay.test.ts[relay anchors select direct-v2 and legacy pointer-v1 independently]
 */
export function hasRelayAnchor(text: string, context: RelayAnchorContext): boolean {
	const message = findMarker(text, "MESSAGE ID", context.relayMessageId) >= 0;
	if (context.transport === DIRECT_RELAY_TRANSPORT) {
		return message && findMarker(text, "RELAY TRANSPORT", DIRECT_RELAY_TRANSPORT) >= 0;
	}
	return message && findMarker(text, "COMMUNICATION FILE", context.communicationFile) >= 0;
}

/** Detects a competing transport marker at the start of a terminal line. */
function hasConflictingTransportMarker(text: string, transport: RelayTransport): boolean {
	const pattern = transport === DIRECT_RELAY_TRANSPORT
		? /^\s*COMMUNICATION\s+FILE\s*:/im
		: /^\s*RELAY\s+TRANSPORT\s*:/im;
	return pattern.test(text);
}

/** Selects the current relay output while rejecting foreign or mixed-version markers.
 * TEST:relay.test.ts[relay anchors select direct-v2 and legacy pointer-v1 independently]
 */
export function currentRelayOutput(text: string, context: RelayAnchorContext, requireRelayAnchor = false): string | undefined {
	const anchored = hasRelayAnchor(text, context);
	const hasAnyMessageMarker = /MESSAGE\s*ID\s*:/i.test(text);
	const hasAnyTransportMarker = /RELAY\s+TRANSPORT\s*:/i.test(text);
	const hasAnyLegacyFileMarker = /COMMUNICATION\s+FILE\s*:/i.test(text);
	if (requireRelayAnchor && !anchored) return undefined;
	if ((hasAnyMessageMarker || hasAnyTransportMarker || hasAnyLegacyFileMarker) && !anchored) return undefined;
	if (anchored && hasConflictingTransportMarker(text, context.transport)) return undefined;
	const messageIndex = findMarker(text, "MESSAGE ID", context.relayMessageId);
	const identityIndex = context.transport === DIRECT_RELAY_TRANSPORT
		? findMarker(text, "RELAY TRANSPORT", DIRECT_RELAY_TRANSPORT)
		: findMarker(text, "COMMUNICATION FILE", context.communicationFile);
	if (messageIndex < 0 && identityIndex < 0) return text;
	if (messageIndex < 0 || identityIndex < 0) return undefined;
	return text.slice(Math.min(messageIndex, identityIndex));
}

/** Builds the legacy pointer envelope retained for old in-flight relay compatibility and tests.
 * TEST:relay.test.ts[relay anchors select direct-v2 and legacy pointer-v1 independently]
 */
export function buildLegacyRelayEnvelope(file: string, lineStart: number, lineEnd: number, lineCount: number, messageId: string, messageType: "task" | "continuation" = "task"): string {
	return [
		`COMMUNICATION FILE: ${file}`,
		`MESSAGE SEQ: ${lineStart}`,
		`MESSAGE LINES: ${lineStart}-${lineEnd}`,
		`MESSAGE LINE COUNT: ${lineCount}`,
		`MESSAGE ID: ${messageId}`,
		`MESSAGE TYPE: ${messageType}`,
		"",
		"Read and parse this JSONL event before acting.",
		"Return exactly these three headings, each on its own line:",
		"STATUS: DONE|BLOCKED|PARTIAL|ERROR",
		"SUMMARY: <one-line result>",
		"VALIDATION: <commands or checks performed>",
		"Use STATUS: DONE only when the task is complete and validated.",
		"Do not delegate recursively.",
	].join("\n");
}
