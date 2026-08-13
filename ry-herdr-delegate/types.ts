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
}

/** Parsed delegate configuration with validated top-level defaults. */
export interface DelegateConfig {
	/** Configuration schema version. */
	version: number;
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
	getAgent(target: string): Promise<HerdrAgentSnapshot>;
	/** Captures recent agent output. */
	readAgent(target: string): Promise<HerdrAgentOutput>;
	/** Creates a tab without changing focus by default. */
	createTab(input: CreateTabInput): Promise<{ tabId: string; paneId?: string }>;
	/** Moves or closes a pane after semantic completion. */
	movePane(input: MovePaneInput): Promise<{ tabId?: string }>;
	/** Closes a pane explicitly. */
	closePane(paneId: string): Promise<void>;
	/** Reads the live Herdr snapshot. */
	snapshot(): Promise<HerdrSnapshot>;
	/** Optionally verifies the Herdr CLI version and JSON response contract. */
	probe?(signal?: AbortSignal): Promise<HerdrCapabilities>;
}

/** Event-log status values used by pipeline submission and coordinator queries. */
export type PipelineStatus = "QUEUED" | "ACCEPTED" | "RUNNING" | "BLOCKED" | "DONE" | "PARTIAL" | "ERROR" | "STOPPED";

/** Durable binding for one project/workspace coordinator child. */
export interface CoordinatorBinding {
	/** Binding schema version. */
	schemaVersion: 1;
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
	/** Active pipeline currently being processed, if any. */
	activePipelineId?: string;
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
}

/** One explicitly planned pipeline stage. */
export interface PipelineStageInput {
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
	| "pane-disposition";

/** One validated, physically line-oriented JSONL event. */
export interface JsonlEvent {
	/** Event schema version. */
	schemaVersion: 1;
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
