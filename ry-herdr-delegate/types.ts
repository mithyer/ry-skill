/** Supported interactive agent kinds exposed by Herdr 0.8+. */
export type AgentKind = "codex" | "claude" | "pi";

/** Transport lifecycle reported by Herdr for an agent pane. */
export type AgentTransportStatus = "working" | "blocked" | "idle" | "done" | "unknown";

/** Semantic status returned by the delegation completion contract. */
export type SemanticStatus = "DONE" | "BLOCKED" | "PARTIAL" | "ERROR";

/** Post-completion disposition for a leaf stage pane. */
export type PanePolicy = "close" | "keep" | "new-tab";

/** Stable identity used to prove exact agent-session continuity. */
export interface SessionIdentity {
	/** Agent implementation kind that owns the session. */
	kind: string;
	/** Runtime that reported the identity, such as `herdr:pi`. */
	source: string;
	/** Complete path or provider session id returned by the runtime. */
	value: string;
}

/** Logging verbosity configured for the runtime debug JSONL file. */
export type DebugLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

/** Levels that can be assigned to an emitted debug event. */
export type DebugEventLevel = Exclude<DebugLevel, "off">;

/** Parsed debug logging configuration. */
export interface DebugConfig {
	/** Logging verbosity; `off` disables file creation. */
	level: DebugLevel;
	/** Optional debug JSONL directory, resolved relative to the current project cwd. */
	directory?: string;
}

/** Agent profile settings after role and invocation-local overrides are resolved. */
export interface ResolvedAgentProfile {
	/** Agent kind used by `herdr agent start`. */
	kind: AgentKind;
	/** Optional model name used to expand model arguments. */
	model?: string;
	/** Thinking/reasoning effort used to expand effort arguments. */
	effort?: string;
	/** Profile arguments that precede autonomy and role arguments. */
	modelArgs: readonly string[];
	/** Profile effort arguments. */
	effortArgs: readonly string[];
	/** Profile-specific extra arguments. */
	extraArgs: readonly string[];
	/** Whether the selected profile retained its autonomy arguments. */
	autonomyEnabled: boolean;
	/** Generic recovery hints retained for human fallback output only. */
	recoveryArgs: readonly string[];
	/** Resolved timeout for this role and invocation. */
	timeoutMs: number;
	/** Resolved pane policy for this role and invocation. */
	panePolicy: PanePolicy;
	/** Environment passed to the Herdr child-start path when capability permits it. */
	env: Readonly<Record<string, string>>;
}

/** Invocation-local overrides accepted by the structured delegate tool. */
export interface DelegateOverrides {
	/** Temporarily selected agent profile. */
	agent?: AgentKind;
	/** Temporarily selected effort. */
	effort?: string;
	/** Arguments appended only for this invocation. */
	extraArgs?: readonly string[];
	/** Working directory override. */
	cwd?: string;
	/** Timeout override in milliseconds. */
	timeoutMs?: number;
	/** Stage pane disposition override. */
	panePolicy?: PanePolicy;
}

/** One configured agent profile as read from the JSON configuration. */
export interface AgentProfileConfig {
	/** Agent kind used by Herdr. */
	kind: AgentKind;
	/** Optional model name or null when the runtime default is used. */
	model?: string | null;
	/** Optional effort name. */
	effort?: string | null;
	/** Arguments containing optional `{model}` placeholders. */
	modelArgs?: readonly string[];
	/** Arguments containing optional `{effort}` placeholders. */
	effortArgs?: readonly string[];
	/** Profile autonomy and other fixed arguments. */
	extraArgs?: readonly string[];
	/** Human-readable recovery hints; never used as exact resume args. */
	recoveryArgs?: readonly string[];
	/** Environment values for the child-start capability. */
	env?: Readonly<Record<string, string>>;
}

/** Role-level configuration that overrides a selected profile. */
export interface RoleConfig {
	/** Profile name resolved for this role. */
	agent: AgentKind;
	/** Optional role effort override. */
	effort?: string;
	/** Optional role extra arguments. */
	extraArgs?: readonly string[];
	/** Optional role timeout override. */
	timeoutMs?: number;
	/** Optional role pane policy override. */
	panePolicy?: PanePolicy;
	/** Optional role environment additions. */
	env?: Readonly<Record<string, string>>;
}

/** Coordinator pipeline process policy. */
export interface PipelineConfig {
	/** Maximum stages accepted in one pipeline request. */
	maxStages: number;
	/** Bounded multi-stage worker policy persisted with each task. */
	concurrency: ConcurrencyConfig;
}

/** Concurrency policy accepted by the version-2 configuration boundary. */
export interface ConcurrencyConfig {
	/** Whether explicit parallel plans may claim more than one stage. */
	enabled: boolean;
	/** Workspace coordinator worker-slot upper bound. */
	maxAgents: number;
	/** Maximum concurrently active pipelines. */
	maxPipelines: number;
	/** Per-pipeline active-stage upper bound. */
	maxConcurrentStages: number;
	/** Base active lease TTL before a stage-specific effective TTL is resolved. */
	leaseTtlMs: number;
	/** Startup grace included in a stage deadline and lease. */
	startupGraceMs: number;
	/** Terminal capture grace included in a stage deadline and lease. */
	captureGraceMs: number;
	/** Control-poll margin included in a stage deadline and lease. */
	controlMarginMs: number;
	/** Durable lease heartbeat interval. */
	heartbeatMs: number;
	/** Active-run control polling interval. */
	controlPollMs: number;
	/** Whether a propagated stage failure cancels sibling work. */
	failFast: boolean;
	/** Policy used when a resource declaration cannot be proven safe. */
	unknownResourcePolicy: "block";
}

/** Parsed delegate configuration with validated top-level defaults. */
export interface DelegateConfig {
	/** Effective configuration schema version. */
	version: number;
	/** In-memory migration marker for a v1 input. */
	configMigration?: "v1-to-v2";
	/** Global invocation defaults. */
	defaults: {
		/** Default leaf timeout. */
		timeoutMs: number;
		/** Default stage pane policy. */
		panePolicy: PanePolicy;
		/** Global environment additions. */
		env: Readonly<Record<string, string>>;
	};
	/** Debug logging settings. */
	debug: DebugConfig;
	/** Named agent profiles. */
	agents: Readonly<Record<AgentKind, AgentProfileConfig>>;
	/** Named stage roles. */
	roles: Readonly<Record<string, RoleConfig>>;
	/** Pipeline process policy. */
	pipelines: {
		/** Default pipeline process policy. */
		default: PipelineConfig;
	};
}

/** Fully resolved request passed to the leaf engine. */
export interface DelegateRequest {
	/** Structured action; the leaf engine accepts only `delegate`. */
	action: "delegate";
	/** Complete task text stored in the JSONL event log. */
	task: string;
	/** Stage role used for isolation and configuration resolution. */
	role: string;
	/** Optional invocation-local profile and runtime overrides. */
	overrides?: DelegateOverrides;
	/** Pipeline transaction identity when a coordinator owns this stage. */
	transaction?: string;
	/** Pipeline stage occurrence. */
	stageOccurrence?: number;
	/** Prior communication log linked to this stage. */
	previousCommunication?: string;
	/** Prior exact stage pane to reuse when it remains open. */
	previousPaneId?: string;
	/** Prior stage agent target to reuse when its pane remains open. */
	previousAgent?: string;
	/** Answer or continuation text for an exact-session continuation. */
	continuation?: string;
	/** Prior exact session linked to this stage. */
	previousSession?: SessionIdentity;
	/** Preallocated communication log used for durable stage linkage. */
	communicationFile?: string;
	/** Absolute deadline shared by every operation in this stage attempt. */
	deadlineAt?: string;
	/** Durable attempt number assigned by the coordinator. */
	attempt?: number;
	/** Fencing token assigned by the coordinator lease. */
	fencingToken?: string;
	/** Canonical resource declarations used for retry and replay checks. */
	resourceKeys?: readonly string[];
	/** Access mode recorded for the stage attempt. */
	access?: StageAccess;
}

/** Parent runtime context required to create a sibling Herdr pane. */
export interface DelegateContext {
	/** Project working directory used for records and child processes. */
	cwd: string;
	/** Current Herdr workspace identifier. */
	workspaceId: string;
	/** Current pane used as the explicit split source. */
	sourcePaneId: string;
	/** Parent session identity, when available. */
	parentSession?: SessionIdentity;
	/** Event actor owning this leaf stage. */
	executionOwner?: "parent" | "coordinator";
	/** Whether non-empty profile environment has been verified for this runtime. */
	childEnvVerified?: boolean;
	/** Optional workspace layout lock used around pane mutations. */
	layoutLock?: <T>(callback: () => Promise<T>) => Promise<T>;
	/** Canonical resource declarations held by the caller's reservation. */
	resourceKeys?: readonly string[];
	/** Access mode held by the caller's reservation. */
	access?: StageAccess;
}

/** One parsed completion contract returned by a child agent. */
export interface CompletionContract {
	/** Required semantic completion status. */
	status: SemanticStatus;
	/** Reported pipeline stage, when present. */
	pipelineStage?: string;
	/** Human-readable result summary. */
	summary?: string;
	/** Changed files as reported by the child. */
	changedFiles?: string;
	/** Validation commands and outcomes. */
	validation?: string;
	/** Remaining risks or open decisions. */
	risks?: string;
	/** Sources or inspected references. */
	sources?: string;
	/** Child-reported session text; runtime session metadata remains authoritative. */
	agentSession?: string;
	/** Human-readable exact recovery command. */
	recoveryCommand?: string;
	/** Recovery semantics description. */
	recoverySemantics?: string;
}

/** Result returned by the leaf delegation engine. */
export interface DelegateResult {
	/** Semantic task result. */
	status: SemanticStatus;
	/** Stable communication identifier. */
	communicationId: string;
	/** Absolute JSONL event-log path. */
	communicationFile: string;
	/** Exact child session captured by the last checkpoint, when available. */
	agentSession?: SessionIdentity;
	/** Herdr pane identifier retained for inspection or disposition. */
	paneId?: string;
	/** Herdr agent target/name. */
	agent?: string;
	/** Parsed completion contract for semantic results. */
	completion?: CompletionContract;
	/** Human-readable error or blocker description. */
	error?: string;
	/** Applied pane disposition, if semantic DONE was validated. */
	paneDisposition?: PaneDispositionResult;
}

/** Result of resolving a pane policy into an executable disposition. */
export interface PaneDispositionResult {
	/** Selected policy. */
	policy: PanePolicy;
	/** Deterministic tab label for the new-tab policy. */
	tabLabel?: string;
}

/** Minimal Herdr pane metadata used by the gateway and engine. */
export interface HerdrPane {
	/** Herdr pane identifier. */
	paneId: string;
	/** Workspace containing the pane. */
	workspaceId?: string;
	/** Tab containing the pane. */
	tabId?: string;
}

/** Accepted/unknown transport evidence needed to classify relay retries safely. */
export interface TransportMetadata {
	/** Herdr operation that produced the evidence. */
	operation: "split" | "start" | "prompt" | "wait" | "read" | "disposition";
	/** Whether the external operation was accepted by Herdr. */
	accepted: boolean | "unknown";
	/** Structured Herdr error code, when available. */
	errorCode?: string;
	/** Transport status observed alongside the operation. */
	observedStatus?: AgentTransportStatus;
	/** Relay/message identity associated with the operation. */
	messageId?: string;
	/** Exact session checkpoint observed with the operation. */
	exactSession?: SessionIdentity;
	/** Terminal capture attempt number. */
	captureAttempt?: number;
}

/** Agent metadata returned by Herdr get/snapshot operations. */
export interface HerdrAgentSnapshot extends HerdrPane {
	/** Herdr agent target/name. */
	agent: string;
	/** Transport lifecycle state. */
	status: AgentTransportStatus;
	/** Exact session identity reported by Herdr. */
	agentSession?: SessionIdentity;
	/** Working directory reported by Herdr. */
	cwd?: string;
	/** Transport acknowledgement metadata retained for retry classification. */
	transport?: TransportMetadata;
}

/** Input for an explicit source-pane split. */
export interface SplitPaneInput {
	/** Explicit source pane identifier. */
	sourcePaneId: string;
	/** Split direction. */
	direction?: "right" | "down";
	/** Working directory for the new pane process. */
	cwd?: string;
	/** Environment values requested for the new pane process. */
	env?: Readonly<Record<string, string>>;
	/** Whether the newly split pane receives UI focus. */
	focus?: boolean;
	/** Cancellation signal for the Herdr process. */
	signal?: AbortSignal;
}

/** Input for starting a supported Herdr agent. */
export interface StartAgentInput {
	/** Unique Herdr agent target/name. */
	name: string;
	/** Supported Herdr agent kind. */
	kind: AgentKind;
	/** Existing pane where the agent shell is ready. */
	paneId: string;
	/** Final validated argv passed after `--`. */
	agentArgs: readonly string[];
	/** Cancellation signal for the Herdr process. */
	signal?: AbortSignal;
}

/** Input for sending an agent prompt. */
export interface PromptInput {
	/** Herdr agent target/name or pane target. */
	target: string;
	/** Relay envelope text. */
	text: string;
	/** Whether Herdr should wait for a settled state after submission. */
	wait?: boolean;
	/** Maximum wait duration. */
	timeoutMs?: number;
	/** Optional cancellation signal forwarded to the Herdr subprocess. */
	signal?: AbortSignal;
}

/** Input for waiting on an agent transport state. */
export interface WaitInput {
	/** Herdr agent target/name or pane target. */
	target: string;
	/** Accepted terminal states. */
	until?: readonly AgentTransportStatus[];
	/** Maximum wait duration. */
	timeoutMs?: number;
	/** Optional cancellation signal forwarded to the Herdr subprocess. */
	signal?: AbortSignal;
}

/** Input for creating a tab without focusing it. */
export interface CreateTabInput {
	/** Workspace where the tab is created. */
	workspaceId: string;
	/** Working directory inherited by the tab. */
	cwd: string;
	/** Human-readable tab label. */
	label: string;
	/** Whether to focus the new tab. */
	focus?: boolean;
	/** Cancellation signal for the Herdr process. */
	signal?: AbortSignal;
}

/** Input for moving a pane into a new or existing tab. */
export interface MovePaneInput {
	/** Pane being moved. */
	paneId: string;
	/** New tab label when `newTab` is true. */
	tabLabel?: string;
	/** Existing destination tab, when used. */
	tabId?: string;
	/** Whether Herdr creates a new tab. */
	newTab?: boolean;
	/** Destination workspace, when explicitly required. */
	workspaceId?: string;
	/** Whether the destination receives focus. */
	focus?: boolean;
	/** Cancellation signal for the Herdr process. */
	signal?: AbortSignal;
}

/** Output captured from an agent pane. */
export interface HerdrAgentOutput {
	/** Raw terminal text. */
	text: string;
}

/** Snapshot returned by `herdr api snapshot`. */
export interface HerdrSnapshot {
	/** Raw parsed snapshot payload. */
	raw: unknown;
	/** Agent snapshots normalized from the payload. */
	agents: readonly HerdrAgentSnapshot[];
}

/** Capabilities verified by the Herdr CLI preflight. */
export interface HerdrCapabilities {
	/** Parsed Herdr CLI semantic version. */
	herdrVersion: string;
	/** Whether agent/pane JSON responses were validated by snapshot probing. */
	jsonSnapshot: boolean;
}


export interface HerdrGateway {
	/** Creates a sibling pane from an explicit source pane. */
	splitPane(input: SplitPaneInput): Promise<HerdrPane>;
	/** Starts an agent with the final validated argv. */
	startAgent(input: StartAgentInput): Promise<HerdrAgentSnapshot>;
	/** Sends a relay prompt to an agent. */
	prompt(input: PromptInput): Promise<HerdrAgentSnapshot | undefined>;
	/** Waits for a requested transport state. */
	waitFor(input: WaitInput): Promise<HerdrAgentSnapshot>;
	/** Reads exact current agent metadata. */
	getAgent(target: string, signal?: AbortSignal): Promise<HerdrAgentSnapshot>;
	/** Captures recent agent output. */
	readAgent(target: string, signal?: AbortSignal): Promise<HerdrAgentOutput>;
	/** Creates a tab without changing focus by default. */
	createTab(input: CreateTabInput): Promise<{ tabId: string; paneId?: string }>;
	/** Moves or closes a pane after semantic completion. */
	movePane(input: MovePaneInput): Promise<{ tabId?: string }>;
	/** Closes a pane explicitly. */
	closePane(paneId: string, signal?: AbortSignal): Promise<void>;
	/** Reads the live Herdr snapshot. */
	snapshot(signal?: AbortSignal): Promise<HerdrSnapshot>;
	/** Optionally verifies the Herdr CLI version and JSON response contract. */
	probe?(signal?: AbortSignal): Promise<HerdrCapabilities>;
}

/** Stage access modes used by the resource conflict matrix. */
export type StageAccess = "read-only" | "workspace-write" | "external-side-effect";

/** Detail state retained for one stage without widening the top-level pipeline status. */
export type PipelineStageDetailStatus =
	| "QUEUED"
	| "CLAIMED"
	| "RUNNING"
	| "DONE"
	| "ERROR"
	| "PARTIAL"
	| "BLOCKED"
	| "CANCELLED"
	| "STALE"
	| "WAITING_FOR_ANSWER"
	| "WAITING_FOR_APPROVAL";

/** Event-log status values used by pipeline submission and coordinator queries. */
export type PipelineStatus = "QUEUED" | "ACCEPTED" | "RUNNING" | "BLOCKED" | "DONE" | "PARTIAL" | "ERROR" | "STOPPED";

/** Replay projection for one pipeline's reserved worker slots. */
export interface ActivePipelineReservation {
	/** Stable reservation identity. */
	reservationId: string;
	/** Pipeline represented by this reservation. */
	pipelineId: string;
	/** Number of coordinator worker slots reserved. */
	reservedSlots: number;
	/** Lease identities represented by this reservation. */
	leaseIds: readonly string[];
	/** Reservation epoch used to reject stale releases. */
	reservationEpoch: number;
	/** Coordinator owner epoch/fence. */
	ownerEpoch: string;
	/** Monotonic release sequence, when released. */
	releaseSequence?: number;
}

/** Durable binding for one project/workspace coordinator child. */
export interface CoordinatorBinding {
	/** Binding schema version. */
	schemaVersion: 1 | 2;
	/** Project root bound to this coordinator. */
	projectRoot: string;
	/** Herdr workspace containing the coordinator pane. */
	workspaceId: string;
	/** Source tab used when the coordinator was created. */
	tabId?: string;
	/** Current coordinator pane. */
	paneId: string;
	/** Current Herdr agent name/target. */
	agent: string;
	/** Coordinator working directory. */
	cwd: string;
	/** Exact coordinator session identity. */
	agentSession: SessionIdentity;
	/** Transport state last observed by the parent. */
	status: AgentTransportStatus;
	/** Path to the durable inbox JSONL file. */
	inboxPath: string;
	/** Legacy active pipeline projection retained for v1 readers. */
	activePipelineId?: string;
	/** Replay-derived reservations currently held by this coordinator. */
	activePipelineReservations?: readonly ActivePipelineReservation[];
	/** Monotonic schema epoch used for writer fencing. */
	schemaEpoch?: number;
	/** Writer fence bound to the exact coordinator session/process. */
	writerFence?: string;
	/** Last parent/coordinator observation timestamp. */
	lastSeenAt: string;
}

/** Durable pipeline request accepted by the parent submission path. */
export interface PipelineSubmission {
	/** Submission state; `QUEUED` does not imply stage completion. */
	status: PipelineStatus;
	/** Stable pipeline identity. */
	pipelineId: string;
	/** Pipeline JSONL event-log path. */
	communicationFile: string;
	/** Coordinator binding identity returned to the parent. */
	coordinator: Pick<CoordinatorBinding, "paneId" | "agent" | "agentSession" | "workspaceId">;
	/** Human-readable blocker/error when submission did not queue. */
	error?: string;
}

/** Targeted control actions shared by new API calls and compatibility wrappers. */
export type PipelineControlAction = "answer" | "approve" | "reject" | "recover" | "stop";

/** Durable target identity supplied with a pipeline control request. */
export interface PipelineControlTarget {
	/** Stable target stage identity. */
	stageId?: string;
	/** Stage occurrence expected by the caller. */
	stageOccurrence?: number;
	/** Attempt expected by the caller. */
	expectedAttempt?: number;
	/** Fencing token expected by the caller. */
	expectedFence?: string;
}

/** Result returned after a coordinator tick or durable control event. */
export interface PipelineControlResult {
	/** Pipeline or control status. */
	status: PipelineStatus;
	/** Pipeline identity when the action targets a pipeline. */
	pipelineId?: string;
	/** Authoritative pipeline event-log path. */
	communicationFile?: string;
	/** Number of stages processed by a coordinator tick. */
	stagesProcessed?: number;
	/** Current stage role when execution stopped or was blocked. */
	currentStage?: string;
	/** Human-readable blocker/error. */
	error?: string;
	/** Target stage identity when a control action was scoped. */
	targetStageId?: string;
	/** Durable control event id, when one was appended. */
	controlId?: string;
}

/** One explicitly planned pipeline stage. */
export interface PipelineStageInput {
	/** Stable logical identity within the pipeline; legacy plans receive a generated id. */
	stageId?: string;
	/** Stage role used for profile and isolation resolution. */
	role: string;
	/** Optional stage-specific task; otherwise the pipeline task is used. */
	task?: string;
	/** Invocation-local profile override. */
	agent?: AgentKind;
	/** Invocation-local effort override. */
	effort?: string;
	/** Invocation-local extra arguments. */
	extraArgs?: readonly string[];
	/** Stage working directory override. */
	cwd?: string;
	/** Invocation-local timeout override. */
	timeoutMs?: number;
	/** Stage pane disposition. */
	panePolicy?: PanePolicy;
	/** Dependencies; omission is legacy serial, an explicit empty list is parallel-ready. */
	dependsOn?: readonly string[];
	/** Resource access mode used by the workspace conflict matrix. */
	access?: StageAccess;
	/** Canonical or user-declared resources required by this stage. */
	resourceKeys?: readonly string[];
	/** Whether failure propagates cancellation to sibling stages. */
	failFast?: boolean;
	/** Optional per-pipeline active-stage limit. */
	maxConcurrentStages?: number;
	/** Internal normalization marker persisted in task metadata. */
	dependencyMode?: "legacy-serial" | "explicit";
}

/** Pipeline task request stored in the pipeline JSONL event log. */
export interface PipelineRequest {
	/** Stable pipeline id. */
	pipelineId: string;
	/** Complete pipeline task. */
	task: string;
	/** Explicit stages, or an empty list for coordinator default planning. */
	stages: readonly PipelineStageInput[];
	/** Default stage pane policy. */
	panePolicy: PanePolicy;
	/** Invocation context retained as structured data. */
	context: Record<string, unknown>;
	/** Physical event range of the task event. */
	lineStart: number;
	/** Physical event end line. */
	lineEnd: number;
	/** Physical event line count. */
	lineCount: number;
	/** Task event sequence. */
	messageSeq: number;
	/** Effective concurrency policy captured at submission time. */
	concurrency?: ConcurrencyConfig;
	/** Configuration migration marker, when a v1 input was upgraded in memory. */
	configMigration?: "v1-to-v2";
}

/** Event actors allowed to append JSONL communication events. */
export type EventActor = "parent" | "coordinator" | "system" | "child-output-capture";

/** Event types used by the append-only communication log. */
export type EventType =
	| "event-log-created"
	| "task"
	| "continuation"
	| "recovery"
	| "checkpoint"
	| "accepted"
	| "status-changed"
	| "result"
	| "error"
	| "pane-disposition"
	| "stage-claimed"
	| "stage-started"
	| "stage-heartbeat"
	| "stage-released"
	| "pipeline.control"
	| "stale-attempt-diagnostic"
	| "stale-control-diagnostic";

/** One validated, physically line-oriented JSONL event. */
export interface JsonlEvent {
	/** Event schema version; v1 records remain replayable while v2 events add concurrency identity. */
	schemaVersion: 1 | 2;
	/** Monotonic one-based sequence number. */
	seq: number;
	/** Stable unique event id. */
	eventId: string;
	/** UTC timestamp. */
	timestamp: string;
	/** Event category. */
	type: EventType;
	/** Process role that owns the append. */
	actor: EventActor;
	/** Transaction identity. */
	transaction: string;
	/** Stage role. */
	stageRole: string;
	/** Occurrence number of this role in the transaction. */
	stageOccurrence: number;
	/** Optional message identity for relay/idempotency. */
	messageId?: string;
	/** Optional exact child session captured by the event. */
	agentSession?: SessionIdentity;
	/** Structured redacted payload. */
	payload: Record<string, unknown>;
}

/** Event data before the store assigns sequence and physical line metadata. */
export type NewJsonlEvent = Omit<JsonlEvent, "seq">;

/** Physical location and event returned after an append. */
export interface AppendedEvent {
	/** Complete event written to disk. */
	event: JsonlEvent;
	/** One-based first physical line. */
	lineStart: number;
	/** One-based last physical line. */
	lineEnd: number;
	/** Number of physical lines occupied by this event. */
	lineCount: number;
	/** Whether an identical existing event was reused idempotently. */
	idempotent: boolean;
}
