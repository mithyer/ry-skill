import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, basename } from "node:path";

import lockfile from "proper-lockfile";

import { debug, debugError } from "./debug.ts";
import type {
	AppendedEvent,
	EventActor,
	EventType,
	JsonlEvent,
	NewJsonlEvent,
	SessionIdentity,
} from "./types.ts";

/** Supported top-level JSONL event keys; all other keys are rejected. */
const EVENT_KEYS = new Set([
	"schemaVersion",
	"seq",
	"eventId",
	"timestamp",
	"type",
	"actor",
	"transaction",
	"stageRole",
	"stageOccurrence",
	"messageId",
	"agentSession",
	"payload",
]);

/** Event types accepted by the runtime event-log schema. */
const EVENT_TYPES = new Set<EventType>([
	"event-log-created",
	"task",
	"continuation",
	"recovery",
	"checkpoint",
	"accepted",
	"status-changed",
	"result",
	"error",
	"pane-disposition",
]);

/** Event actors accepted by the runtime event-log schema. */
const EVENT_ACTORS = new Set<EventActor>(["parent", "coordinator", "system", "child-output-capture"]);

/** Keys whose values must never be persisted as plaintext in an event payload. */
const SENSITIVE_KEY = /password|token|secret|cookie|private.?key|api.?key|authorization/i;

/** A replayed event with its physical one-line location. */
export interface LocatedJsonlEvent {
	/** Validated event value. */
	event: JsonlEvent;
	/** One-based physical line number. */
	line: number;
}

/** Consistent read result for a JSONL event log. */
export interface EventLogSnapshot {
	/** Absolute event-log path. */
	file: string;
	/** Validated events in sequence order. */
	events: readonly LocatedJsonlEvent[];
}

/** Optional lock settings kept injectable for deterministic tests. */
export interface EventLogStoreOptions {
	/** Lock stale threshold in milliseconds. */
	staleMs?: number;
	/** Number of lock acquisition retries. */
	retries?: number;
}

/** Converts a value to a stable JSON string for idempotency comparisons. */
function stableJson(value: unknown): string {
	return JSON.stringify(value);
}

/** Returns whether a value is a plain object suitable for JSON event fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Produces an event-specific validation error with the physical line context. */
function invalidEvent(message: string, line?: number): Error {
	return new Error(`Invalid JSONL event${line === undefined ? "" : ` at line ${line}`}: ${message}`);
}

/** Validates an exact session identity object. */
function validateSessionIdentity(value: unknown, path: string): asserts value is SessionIdentity {
	if (!isRecord(value)) throw invalidEvent(`${path} must be an object`);
	for (const key of ["kind", "source", "value"]) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			throw invalidEvent(`${path}.${key} must be a non-empty string`);
		}
	}
}

/** Validates a decoded event and returns the same object with a narrow type. */
function validateEvent(value: unknown, line?: number): JsonlEvent {
	if (!isRecord(value)) throw invalidEvent("event must be a JSON object", line);
	for (const key of Object.keys(value)) {
		if (!EVENT_KEYS.has(key)) throw invalidEvent(`unknown top-level field ${key}`, line);
	}
	if (value.schemaVersion !== 1) throw invalidEvent("schemaVersion must be 1", line);
	if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) throw invalidEvent("seq must be a positive integer", line);
	for (const key of ["eventId", "timestamp", "transaction", "stageRole"]) {
		if (typeof value[key] !== "string" || (value[key] as string).length === 0) {
			throw invalidEvent(`${key} must be a non-empty string`, line);
		}
	}
	if (typeof value.type !== "string" || !EVENT_TYPES.has(value.type as EventType)) {
		throw invalidEvent("type is unsupported", line);
	}
	if (typeof value.actor !== "string" || !EVENT_ACTORS.has(value.actor as EventActor)) {
		throw invalidEvent("actor is unsupported", line);
	}
	if (!Number.isSafeInteger(value.stageOccurrence) || (value.stageOccurrence as number) < 1) {
		throw invalidEvent("stageOccurrence must be a positive integer", line);
	}
	if (value.messageId !== undefined && (typeof value.messageId !== "string" || value.messageId.length === 0)) {
		throw invalidEvent("messageId must be a non-empty string when present", line);
	}
	if (value.agentSession !== undefined) validateSessionIdentity(value.agentSession, "agentSession");
	if (!isRecord(value.payload)) throw invalidEvent("payload must be an object", line);
	return value as unknown as JsonlEvent;
}

/** Validates an entire event-log text and rejects incomplete or damaged tails. */
function parseEventLogText(text: string, file: string): LocatedJsonlEvent[] {
	if (text.length === 0) return [];
	if (!text.endsWith("\n")) throw new Error(`JSONL event log has an incomplete final line: ${file}`);
	const lines = text.slice(0, -1).split("\n");
	const events: LocatedJsonlEvent[] = [];
	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		if (lines[index].length === 0) throw invalidEvent("empty lines are not allowed", lineNumber);
		let value: unknown;
		try {
			value = JSON.parse(lines[index]);
		} catch {
			throw invalidEvent("line is not valid JSON", lineNumber);
		}
		const event = validateEvent(value, lineNumber);
		const expectedSeq = lineNumber;
		if (event.seq !== expectedSeq) throw invalidEvent(`seq ${event.seq} does not match physical line ${expectedSeq}`, lineNumber);
		const existing = events.find(({ event: item }) => item.eventId === event.eventId);
		if (existing) {
			throw invalidEvent(`eventId ${event.eventId} is duplicated`, lineNumber);
		}
		if (event.messageId) {
			const message = events.find(({ event: item }) => item.messageId === event.messageId);
			if (message) {
				throw invalidEvent(`messageId ${event.messageId} is duplicated`, lineNumber);
			}
		}
		events.push({ event, line: lineNumber });
	}
	return events;
}

/** Redacts sensitive object-key values before they enter the durable event log. */
export function redactSensitivePayload(value: unknown, key?: string): unknown {
	if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
	if (Array.isArray(value)) return value.map((item) => redactSensitivePayload(item));
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactSensitivePayload(childValue, childKey)]));
	}
	return value;
}

/** Ensures a JSONL event-log file exists before proper-lockfile resolves its sidecar path. */
export async function ensureEventLog(file: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	try {
		await stat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const handle = await open(file, "wx");
		await handle.close();
	}
}

/** Creates a new empty event log and rejects an existing non-empty or malformed file. */
export async function createEventLog(file: string): Promise<void> {
	await ensureEventLog(file);
	const snapshot = await readEventLog(file);
	if (snapshot.events.length > 0) throw new Error(`JSONL event log already contains events: ${file}`);
}

/** Runs a callback while holding the filesystem sidecar lock for one event log. */
async function withEventLogLock<T>(file: string, options: EventLogStoreOptions, callback: () => Promise<T>): Promise<T> {
	await ensureEventLog(file);
	const release = await lockfile.lock(file, {
		realpath: false,
		stale: Math.max(options.staleMs ?? 10000, 2000),
		retries: {
			retries: options.retries ?? 20,
			minTimeout: 10,
			maxTimeout: 250,
			factor: 1.5,
		},
	});
	try {
		return await callback();
	} finally {
		await release();
	}
}

/** Reads and validates an event log without taking a lock; callers must already own one for writes. */
async function readEventLogUnlocked(file: string): Promise<EventLogSnapshot> {
	const text = await readFile(file, "utf8");
	return { file, events: parseEventLogText(text, file) };
}

/** Reads and validates the complete event log under its sidecar lock. */
export async function readEventLog(file: string, options: EventLogStoreOptions = {}): Promise<EventLogSnapshot> {
	const startedAt = Date.now();
	await debug.log("record.read.start", { file }, "trace");
	try {
		const snapshot = await withEventLogLock(file, options, () => readEventLogUnlocked(file));
		await debug.log("record.read.result", { file, eventCount: snapshot.events.length, elapsedMs: Date.now() - startedAt }, "trace");
		return snapshot;
	} catch (error) {
		await debug.log("record.read.failed", { file, elapsedMs: Date.now() - startedAt, error: debugError(error) }, "error");
		throw error;
	}
}

/** Builds a new event after redacting its structured payload. */
function materializeEvent(input: NewJsonlEvent, seq: number): JsonlEvent {
	if (Object.prototype.hasOwnProperty.call(input, "seq")) throw new Error("new JSONL event must not provide seq");
	const event = { ...input, seq, payload: redactSensitivePayload(input.payload) } as JsonlEvent;
	return validateEvent(event);
}

/** Compares event content while ignoring the assigned sequence number. */
function sameEventBody(left: JsonlEvent, right: JsonlEvent): boolean {
	const { seq: _leftSeq, ...leftBody } = left;
	const { seq: _rightSeq, ...rightBody } = right;
	return stableJson(leftBody) === stableJson(rightBody);
}

/** Appends one event with lock, sequence, idempotency, and read-after-write validation. */
export async function appendEvent(
	file: string,
	input: NewJsonlEvent,
	options: EventLogStoreOptions = {},
): Promise<AppendedEvent> {
	const startedAt = Date.now();
	await debug.log("record.append.start", {
		file,
		type: input.type,
		actor: input.actor,
		transaction: input.transaction,
		stageRole: input.stageRole,
		stageOccurrence: input.stageOccurrence,
		eventId: input.eventId,
		messageId: input.messageId,
	}, "trace");
	try {
		const appended = await withEventLogLock(file, options, async () => {
		const before = await readEventLogUnlocked(file);
		const existingByEventId = before.events.find(({ event }) => event.eventId === input.eventId);
		const existingByMessageId = input.messageId
			? before.events.find(({ event }) => event.messageId === input.messageId)
			: undefined;
		if (existingByEventId || existingByMessageId) {
			if (!existingByEventId || (existingByMessageId && existingByEventId.event.eventId !== existingByMessageId.event.eventId)) {
				throw new Error("JSONL event idempotency conflict: eventId and messageId identify different events");
			}
			const expected = materializeEvent(input, existingByEventId.event.seq);
			if (!sameEventBody(expected, existingByEventId.event)) {
				throw new Error(`JSONL event idempotency conflict for ${input.eventId}`);
			}
			return {
				event: existingByEventId.event,
				lineStart: existingByEventId.line,
				lineEnd: existingByEventId.line,
				lineCount: 1,
				idempotent: true,
			};
		}
		const event = materializeEvent(input, before.events.length + 1);
		await writeFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
		const after = await readEventLogUnlocked(file);
		const located = after.events.find(({ event: item }) => item.eventId === event.eventId);
		if (!located || !sameEventBody(located.event, event) || located.event.seq !== event.seq) {
			throw new Error("JSONL event read-after-write validation failed");
		}
		return {
			event,
			lineStart: located.line,
			lineEnd: located.line,
			lineCount: 1,
			idempotent: false,
		};
		});
		await debug.log("record.append.result", {
			file,
			type: appended.event.type,
			eventId: appended.event.eventId,
			messageId: appended.event.messageId,
			seq: appended.event.seq,
			lineStart: appended.lineStart,
			idempotent: appended.idempotent,
			elapsedMs: Date.now() - startedAt,
		}, "trace");
		return appended;
	} catch (error) {
		await debug.log("record.append.failed", { file, eventId: input.eventId, type: input.type, elapsedMs: Date.now() - startedAt, error: debugError(error) }, "error");
		throw error;
	}
}

/** Derives the stable communication identifier from a `.jsonl` event-log path. */
export function communicationIdFromPath(file: string): string {
	const name = basename(file);
	if (!name.endsWith(".jsonl") || name.length <= ".jsonl".length) {
		throw new Error(`Communication file must be a non-empty .jsonl path: ${file}`);
	}
	return name.slice(0, -".jsonl".length);
}

/** Creates the mandatory event-log-created event for a new communication file. */
export function createEventLogEvent(
	transaction: string,
	stageRole: string,
	stageOccurrence: number,
	actor: EventActor = "system",
): NewJsonlEvent {
	return {
		schemaVersion: 1,
		eventId: `event-log-${crypto.randomUUID()}`,
		timestamp: new Date().toISOString(),
		type: "event-log-created",
		actor,
		transaction,
		stageRole,
		stageOccurrence,
		payload: { communicationId: "pending" },
	};
}
