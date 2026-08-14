import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { buildFinalAgentArgs } from "./args.ts";
import { DelegateEngine } from "./engine.ts";
import { resolveAgentProfile, type ConfigCapabilities } from "./config.ts";
import { debug, debugError, hashDebugText } from "./debug.ts";
import { createEventLog } from "./records.ts";
import { canonicalCwdResourceKey, WorkspaceReservationLedger, type ReservationProjection } from "./concurrency.ts";
import type {
	CoordinatorBinding,
	ActivePipelineReservation,
	ConcurrencyConfig,
	DelegateConfig,
	HerdrGateway,
	PipelineSubmission,
	PipelineControlAction,
	PipelineControlResult,
	PipelineControlTarget,
	PipelineStageInput,
	SessionIdentity,
} from "./types.ts";
import { PipelineStore, type PipelineInboxEntry, type PipelineProgress, type PipelineRequestInput } from "./pipeline.ts";

/** Long-lived coordinator profile role name. */
const COORDINATOR_ROLE = "delegate";

/** Fixed coordinator bootstrap contract; the structured runtime exclusively owns durable JSONL writes. */
export const COORDINATOR_BOOTSTRAP = [
	"You are the long-lived pipeline coordinator for this project and Herdr workspace.",
	"When you receive an inbox or control pointer, call ry_herdr_delegate_tool exactly once with action pipeline.coordinator.",
	"The structured tool replays the durable inbox, performs leaf delegation, and appends every receipt, checkpoint, result, blocker, and final summary.",
	"Do not directly read, write, append, edit, or repair pipeline JSONL, inbox files, coordinator state, or any other filesystem state.",
	"Do not submit a pipeline, create another coordinator, delegate recursively, or use shell commands for coordination.",
	"Report the structured tool result and keep this coordinator pane open.",
].join("\n");

/** Coordinator lifecycle dependencies. */
export interface CoordinatorDependencies {
	/** Herdr gateway used for pane and agent lifecycle. */
	gateway: HerdrGateway;
	/** Parsed delegate configuration. */
	config: DelegateConfig;
	/** Project/workspace-specific persistent stores. */
	pipelineStore: PipelineStore;
	/** Capability flags for profile environment behavior. */
	capabilities?: ConfigCapabilities;
	/** Stable ID factory for deterministic tests. */
	id?: () => string;
}

/** One claimed stage execution kept outside the global execution lock. */
interface ActiveStageRun {
	/** Pipeline and stable stage identity. */
	pipelineId: string;
	stageId: string;
	/** Attempt/fence identity used for stale-result rejection. */
	attempt: number;
	fencingToken: string;
	/** Durable reservation identity. */
	reservationId: string;
	/** Per-stage cancellation controller. */
	controller: AbortController;
	/** Lease owner epoch. */
	ownerEpoch: string;
	/** Absolute deadline for the stage attempt. */
	deadlineAt: string;
}

/** One stage selected during a short claim transaction. */
interface ClaimedStage {
	/** Pipeline progress used for replay and task lookup. */
	progress: PipelineProgress;
	/** Inbox entry that owns the pipeline. */
	entry: PipelineInboxEntry;
	/** Stage plan index and identity. */
	stageIndex: number;
	stageId: string;
	/** Lease identity. */
	attempt: number;
	fencingToken: string;
	reservationId: string;
	ownerEpoch: string;
	deadlineAt: string;
	resourceKeys: readonly string[];
}

/** Result of checking or creating the long-lived coordinator. */
export interface CoordinatorHandle {
	/** Durable binding after verification. */
	binding: CoordinatorBinding;
	/** Whether a new coordinator pane/session was created. */
	created: boolean;
}

/** Submission mode used by the parent tool. */
export type CoordinatorSubmitResult = PipelineSubmission;

/** Owns one persistent project/workspace-bound coordinator child. */
export class PipelineCoordinator {
	/** Maximum bounded wait used only to observe a coordinator accepted acknowledgement. */
	private readonly acceptedWaitMs = 1500;

	/** Herdr and persistence dependencies. */
	private readonly dependencies: CoordinatorDependencies;
	/** Workspace reservation ledger is the authoritative slot/resource source. */
	private readonly ledger: WorkspaceReservationLedger;
	/** Active stage controllers polled for durable stop/control events. */
	private readonly activeRuns = new Map<string, ActiveStageRun>();

	/**
	 * Creates a persistent coordinator manager.
	 *
	 * @param dependencies Gateway, config, pipeline store, capabilities, and test seams.
	 */
	constructor(dependencies: CoordinatorDependencies) {
		this.dependencies = dependencies;
		this.ledger = new WorkspaceReservationLedger(
			dependencies.pipelineStore.coordinatorStore.projectRoot,
			dependencies.pipelineStore.coordinatorStore.workspaceId,
			{ leaseTtlMs: dependencies.config.pipelines.default.concurrency.leaseTtlMs },
		);
	}

	/**
	 * Reuses an exact open coordinator or creates one under the binding lock.
	 *
	 * @param projectRoot Project root bound to the coordinator.
	 * @param workspaceId Herdr workspace identity.
	 * @param sourcePaneId Parent pane used for the first split.
	 * @param cwd Working directory inherited by the coordinator child.
	 * @param signal Optional cancellation signal.
	 * @returns Verified coordinator binding and creation state.
	 * TEST:coordinator.test.ts[PipelineCoordinator creates and reuses one exact binding]
	 */
	async ensure(projectRoot: string, workspaceId: string, sourcePaneId: string, cwd: string, signal?: AbortSignal): Promise<CoordinatorHandle> {
		await debug.log("coordinator.ensure.start", { projectRoot, workspaceId, sourcePaneId, cwd, signalAborted: signal?.aborted ?? false }, "debug");
		if (this.dependencies.gateway.probe) await this.dependencies.gateway.probe(signal);
		const store = this.dependencies.pipelineStore.coordinatorStore;
		return store.withLock(async () => {
			const current = await store.read();
			if (current) {
				const verified = await this.verifyBinding(current, signal);
				if (verified) {
					await debug.log("coordinator.ensure.reused", { paneId: verified.paneId, agent: verified.agent, workspaceId: verified.workspaceId, status: verified.status, agentSession: verified.agentSession }, "debug");
					return { binding: verified, created: false };
				}
				const recovered = await this.recoverClosedBinding(current, projectRoot, workspaceId, sourcePaneId, cwd, signal);
				if (recovered) {
					await debug.log("coordinator.ensure.recovered", { paneId: recovered.paneId, agent: recovered.agent, workspaceId: recovered.workspaceId, status: recovered.status, agentSession: recovered.agentSession }, "warn");
					return { binding: recovered, created: true };
				}
				throw new Error("Coordinator binding exists but pane/session identity is not definitively reusable");
			}
			return this.create(projectRoot, workspaceId, sourcePaneId, cwd, undefined, signal);
		});
	}

	/** Recreates a definitively closed coordinator from its saved exact session. */
	private async recoverClosedBinding(
		binding: CoordinatorBinding,
		projectRoot: string,
		workspaceId: string,
		sourcePaneId: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<CoordinatorBinding | undefined> {
		if (signal?.aborted) return undefined;
		try {
			const snapshot = await this.dependencies.gateway.getAgent(binding.agent, signal);
			if (!snapshot.agentSession || !sameSession(snapshot.agentSession, binding.agentSession)) throw new Error("Coordinator pane remains present but exact session metadata is missing or mismatched");
			if (!snapshot.workspaceId || snapshot.workspaceId !== binding.workspaceId) throw new Error("Coordinator pane belongs to another or unidentified Herdr workspace");
			return undefined;
		} catch (error) {
			if (!isDefinitivelyClosedAgentLookup(error)) throw error;
			const recovered = await this.create(projectRoot, workspaceId, sourcePaneId, cwd, { agent: binding.agent, session: binding.agentSession }, signal);
			return recovered.binding;
		}
	}

	/** Creates the coordinator pane, starts Pi, verifies exact session, and publishes binding. */
	private async create(projectRoot: string, workspaceId: string, sourcePaneId: string, cwd: string, resume?: { agent: string; session: SessionIdentity }, signal?: AbortSignal): Promise<CoordinatorHandle> {
		const store = this.dependencies.pipelineStore.coordinatorStore;
		await debug.log("coordinator.create.start", { projectRoot, workspaceId, sourcePaneId, cwd, resume: Boolean(resume), previousAgent: resume?.agent, previousSession: resume?.session }, "debug");
		const pane = await store.withLayoutLock(() => this.dependencies.gateway.splitPane({ sourcePaneId, direction: "right", cwd, focus: false, signal }));
		const profile = resolveAgentProfile(this.dependencies.config, COORDINATOR_ROLE, { agent: "pi" }, this.dependencies.capabilities);
		const agent = resume?.agent ?? `pipeline-coordinator-${(this.dependencies.id ?? (() => randomUUID().slice(0, 8)))()}`;
		const args = buildFinalAgentArgs(profile, resume?.session);
		const started = await store.withLayoutLock(() => this.dependencies.gateway.startAgent({ name: agent, kind: "pi", paneId: pane.paneId, agentArgs: args, signal }));
		if (!started.workspaceId || started.workspaceId !== workspaceId) {
			await this.dependencies.gateway.closePane(started.paneId, signal).catch(() => undefined);
			throw new Error("Coordinator start did not return the requested Herdr workspace");
		}
		if (!started.agentSession) throw new Error("Coordinator start did not return exact agent_session metadata");
		if (resume && !sameSession(started.agentSession, resume.session)) {
			await this.dependencies.gateway.closePane(started.paneId, signal).catch(() => undefined);
			throw new Error("Coordinator exact-session recovery returned a different session");
		}
		const binding: CoordinatorBinding = {
			schemaVersion: 2,
			projectRoot,
			workspaceId,
			tabId: started.tabId,
			paneId: started.paneId,
			agent: started.agent,
			cwd,
			agentSession: started.agentSession,
			status: started.status,
			inboxPath: store.inboxPath,
			activePipelineReservations: [],
			schemaEpoch: 2,
			writerFence: `${started.agentSession.source}:${started.agentSession.value}:${process.pid}`,
			lastSeenAt: new Date().toISOString(),
		};
		await store.write(binding);
		await debug.log("coordinator.create.bound", { paneId: binding.paneId, agent: binding.agent, workspaceId: binding.workspaceId, status: binding.status, agentSession: binding.agentSession, inboxPath: binding.inboxPath }, "debug");
		await this.sendBootstrap(binding);
		return { binding, created: true };
	}

	/** Verifies pane and exact session identity before reusing a persisted binding. */
	private async verifyBinding(binding: CoordinatorBinding, signal?: AbortSignal): Promise<CoordinatorBinding | undefined> {
		if (signal?.aborted) return undefined;
		try {
			const snapshot = await this.dependencies.gateway.getAgent(binding.agent, signal);
			if (!snapshot.agentSession || !sameSession(snapshot.agentSession, binding.agentSession)) return undefined;
			if (!snapshot.workspaceId || snapshot.workspaceId !== binding.workspaceId) return undefined;
			return await this.dependencies.pipelineStore.coordinatorStore.write({
				...binding,
				status: snapshot.status,
				paneId: snapshot.paneId,
				lastSeenAt: new Date().toISOString(),
			});
		} catch {
			return undefined;
		}
	}

	/** Sends bootstrap only to a newly created or explicitly idle coordinator. */
	private async sendBootstrap(binding: CoordinatorBinding, signal?: AbortSignal): Promise<void> {
		const relay = [
			`INBOX FILE: ${binding.inboxPath}`,
			"INBOX FORMAT: JSONL",
			"MESSAGE TYPE: coordinator-bootstrap",
			"",
			COORDINATOR_BOOTSTRAP,
		].join("\n");
		await this.dependencies.gateway.prompt({ target: binding.agent, text: relay, wait: false, signal });
	}

	/** Persists a full pipeline request, then appends a compact inbox entry without waiting for stage work. */
	async submit(input: PipelineRequestInput, projectRoot: string, workspaceId: string, sourcePaneId: string, cwd: string, signal?: AbortSignal, callerSession?: SessionIdentity): Promise<CoordinatorSubmitResult> {
		await debug.log("coordinator.submit.start", {
			workspaceId,
			sourcePaneId,
			cwd,
			stageCount: input.stages?.length ?? 0,
			panePolicy: input.panePolicy,
			task: { length: input.task.length, sha256: hashDebugText(input.task) },
			callerSession,
		}, "info");
		let callerIsCoordinator = false;
		if (callerSession) {
			try {
				callerIsCoordinator = await this.isExactCoordinatorCaller(projectRoot, workspaceId, sourcePaneId, callerSession, signal);
			} catch (error) {
				return {
					status: "BLOCKED",
					pipelineId: "",
					communicationFile: "",
					coordinator: { paneId: sourcePaneId, agent: "", agentSession: callerSession, workspaceId },
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
		if (callerIsCoordinator && callerSession) {
			return {
				status: "BLOCKED",
				pipelineId: "",
				communicationFile: "",
				coordinator: { paneId: sourcePaneId, agent: "", agentSession: callerSession, workspaceId },
				error: "coordinator execution cannot submit another pipeline",
			};
		}
		if (this.dependencies.gateway.probe) await this.dependencies.gateway.probe(signal);
		if (process.env.RY_HERDR_EXECUTION_OWNER === "coordinator") {
			return {
				status: "BLOCKED",
				pipelineId: "",
				communicationFile: "",
				coordinator: {
					paneId: sourcePaneId,
					agent: "",
					agentSession: callerSession ?? { kind: "unknown", source: "runtime", value: "coordinator" },
					workspaceId,
				},
				error: "coordinator execution cannot submit another pipeline",
			};
		}
		const pipelineId = `pipeline-${(this.dependencies.id ?? (() => randomUUID().slice(0, 12)))()}`;
		const queued = await this.dependencies.pipelineStore.createRequestAndEnqueue({
			...input,
			concurrency: this.dependencies.config.pipelines.default.concurrency,
			...(this.dependencies.config.configMigration ? { configMigration: this.dependencies.config.configMigration } : {}),
		}, pipelineId, pipelineId, this.dependencies.config.pipelines.default.maxStages);
		const request = queued.request;
		const entry = queued.entry;
		await debug.log("coordinator.submit.enqueued", { pipelineId, communicationFile: request.communicationFile, enqueueSeq: entry.enqueueSeq, messageId: entry.messageId }, "debug");
		const handle = await this.ensure(projectRoot, workspaceId, sourcePaneId, cwd, signal);
		const store = this.dependencies.pipelineStore.coordinatorStore;
		let binding = handle.binding;
		let shouldWaitForAccepted = false;
		let relayError: string | undefined;
		await store.withLock(async () => {
			const currentBinding = await store.read();
			if (!currentBinding) throw new Error("Coordinator binding disappeared after pipeline enqueue");
			binding = currentBinding;
			try {
				const current = await this.dependencies.gateway.getAgent(binding.agent, signal);
				if (current.status === "idle" || current.status === "done") {
					await this.promptInbox(binding, entry, signal);
					shouldWaitForAccepted = true;
				}
			} catch (error) {
				relayError = error instanceof Error ? error.message : String(error);
			}
		});
		if (relayError) {
			const result = this.dependencies.pipelineStore.submission(entry, binding, "PARTIAL", relayError);
			await debug.log("coordinator.submit.result", { pipelineId, status: result.status, communicationFile: result.communicationFile, error: relayError }, "warn");
			return result;
		}
		if (shouldWaitForAccepted && await this.waitForAccepted(entry.pipelineId)) {
			const result = this.dependencies.pipelineStore.submission(entry, binding, "ACCEPTED");
			await debug.log("coordinator.submit.result", { pipelineId, status: result.status, communicationFile: result.communicationFile, coordinatorPaneId: binding.paneId }, "info");
			return result;
		}
		const result = this.dependencies.pipelineStore.submission(entry, binding, "QUEUED");
		await debug.log("coordinator.submit.result", { pipelineId, status: result.status, communicationFile: result.communicationFile, coordinatorPaneId: binding.paneId }, "info");
		return result;
	}

	/** Waits for a bounded accepted event without waiting for any stage result. */
	private async waitForAccepted(pipelineId: string): Promise<boolean> {
		const deadline = Date.now() + this.acceptedWaitMs;
		await debug.log("coordinator.accepted.wait.start", { pipelineId, timeoutMs: this.acceptedWaitMs }, "trace");
		while (Date.now() < deadline) {
			const state = await this.dependencies.pipelineStore.readState(pipelineId);
			if (state.acceptedSeq !== undefined) {
				await debug.log("coordinator.accepted.wait.result", { pipelineId, acceptedSeq: state.acceptedSeq, status: state.status }, "trace");
				return true;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await debug.log("coordinator.accepted.wait.timeout", { pipelineId, timeoutMs: this.acceptedWaitMs }, "trace");
		return false;
	}

	/** Sends only a durable inbox pointer when coordinator transport is idle. */
	private async promptInbox(binding: CoordinatorBinding, entry: PipelineInboxEntry, signal?: AbortSignal): Promise<void> {
		const relay = [
			`INBOX FILE: ${binding.inboxPath}`,
			`PIPELINE ID: ${entry.pipelineId}`,
			`INBOX LINE: ${entry.enqueueSeq}`,
			`EVENT LOG: ${entry.communicationFile}`,
			"MESSAGE TYPE: pipeline-queued",
			"",
			"Read this inbox entry and acknowledge it by appending an accepted event to the pipeline JSONL event log.",
		].join("\n");
		await this.dependencies.gateway.prompt({ target: binding.agent, text: relay, wait: false, signal });
	}

	/**
	 * Reads and exact-verifies an existing coordinator while holding the binding lock.
	 *
	 * @param projectRoot Project root bound to the coordinator.
	 * @param workspaceId Herdr workspace bound to the coordinator.
	 * @param signal Optional cancellation signal.
	 * @returns The verified durable coordinator binding.
	 * @throws When no binding exists or exact pane/session reuse cannot be proven.
	 * TEST:coordinator.test.ts[PipelineCoordinator exact-resumes a definitively closed coordinator]
	 */
	async existingBinding(projectRoot: string, workspaceId: string, signal?: AbortSignal): Promise<CoordinatorBinding> {
		if (this.dependencies.gateway.probe) await this.dependencies.gateway.probe(signal);
		const store = this.dependencies.pipelineStore.coordinatorStore;
		return store.withLock(async () => {
			const current = await store.read();
			if (!current) throw new Error("No coordinator binding exists for this project and workspace");
			const verified = await this.verifyBinding(current, signal);
			if (!verified) throw new Error("Coordinator binding exists but pane/session identity is not definitively reusable");
			return verified;
		});
	}

	/** Verifies whether a caller is the exact persisted coordinator session.
	 *
	 * @param projectRoot Project root bound to the coordinator.
	 * @param workspaceId Herdr workspace bound to the coordinator.
	 * @param paneId Caller Herdr pane identifier.
	 * @param session Caller exact session identity.
	 * @param signal Optional cancellation signal.
	 * @returns True only when the caller matches a live exact coordinator binding.
	 * @throws When a matching binding exists but its transport identity cannot be verified.
	 */
	async isExactCoordinatorCaller(projectRoot: string, workspaceId: string, paneId: string, session: SessionIdentity, signal?: AbortSignal): Promise<boolean> {
		const store = this.dependencies.pipelineStore.coordinatorStore;
		return store.withLock(async () => {
			const current = await store.read();
			if (!current) return false;
			if (current.paneId === paneId && !sameSession(current.agentSession, session)) throw new Error("Coordinator caller pane has a mismatched exact session");
			if (current.paneId !== paneId) return false;
			const verified = await this.verifyBinding(current, signal);
			if (!verified) throw new Error("Exact coordinator caller identity could not be verified");
			return true;
		});
	}


	/** Appends a target-scoped, versioned control event and wakes the coordinator safely. */
	async control(
		pipelineId: string,
		action: PipelineControlAction,
		projectRoot: string,
		workspaceId: string,
		options: { answer?: string; target?: PipelineControlTarget; planHash?: string; previousCommunication?: string; previousPaneId?: string; previousAgent?: string; previousSession?: SessionIdentity } = {},
		signal?: AbortSignal,
	): Promise<PipelineControlResult> {
		return this.dependencies.pipelineStore.coordinatorStore.withExecutionLock(async () => {
			if (action === "answer" && !options.answer?.trim()) return { status: "ERROR", pipelineId, error: "pipeline.answer requires a non-empty answer" };
			const binding = await this.existingBinding(projectRoot, workspaceId, signal);
			const progress = await this.dependencies.pipelineStore.readProgress(pipelineId, this.dependencies.config.pipelines.default.maxStages, binding.writerFence);
		const candidates = progress.stages.filter((stage) => !options.target?.stageId || stage.stageId === options.target.stageId);
		const target = candidates.filter((stage) => action === "stop" || action === "recover" ? ["BLOCKED", "ERROR", "PARTIAL"].includes(stage.status) : stage.status === "BLOCKED");
		if (action !== "stop" && target.length !== 1) return { status: "BLOCKED", pipelineId, communicationFile: progress.state.communicationFile, error: target.length === 0 ? "pipeline has no matching target stage" : "control target is required when multiple stages are blocked" };
		const selected = target[0];
		if (selected && options.target?.expectedAttempt !== undefined && selected.attempt !== options.target.expectedAttempt) return { status: "BLOCKED", pipelineId, communicationFile: progress.state.communicationFile, targetStageId: selected.stageId, error: "control expected attempt does not match current stage" };
		if (selected && options.target?.expectedFence !== undefined && selected.fencingToken !== options.target.expectedFence) return { status: "BLOCKED", pipelineId, communicationFile: progress.state.communicationFile, targetStageId: selected.stageId, error: "control expected fence does not match current stage" };
		const targetStages = action === "stop" ? progress.stages.filter((stage) => !["DONE", "ERROR", "PARTIAL"].includes(stage.status)) : selected ? [selected] : [];
		const controlId = `${action}-${pipelineId}-${options.target?.stageId ?? "pipeline"}-${randomUUID()}`;
		const appended = await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "pipeline.control", "parent", {
			controlId,
			action,
			targetScope: "pipeline",
			targetStageIds: targetStages.map((stage) => stage.stageId),
			pipelineFence: binding.writerFence ?? `${binding.agentSession.source}:${binding.agentSession.value}`,
			expected: targetStages.map((stage) => ({ stageId: stage.stageId, attempt: stage.attempt, fencingToken: stage.fencingToken })),
			...(options.answer !== undefined ? { answer: options.answer } : {}),
			...(options.planHash ? { planHash: options.planHash } : {}),
			...(options.previousCommunication ? { previousCommunication: options.previousCommunication } : {}),
			...(options.previousPaneId ? { previousPaneId: options.previousPaneId } : {}),
			...(options.previousAgent ? { previousAgent: options.previousAgent } : {}),
			...(options.previousSession ? { previousSession: options.previousSession } : {}),
		}, controlId, { stageId: selected?.stageId, stageRole: selected?.role ?? "pipeline", stageOccurrence: (selected?.stageIndex ?? 0) + 1, attempt: selected?.attempt, fencingToken: selected?.fencingToken, schemaVersion: 2 });
		const current = await this.dependencies.gateway.getAgent(binding.agent, signal);
		if (current.status === "idle" || current.status === "done") {
			await this.promptControl(binding, progress.state.communicationFile, appended, `pipeline-${action}`, signal);
			return { status: action === "stop" ? "STOPPED" : "ACCEPTED", pipelineId, communicationFile: progress.state.communicationFile, targetStageId: selected?.stageId, controlId };
		}
		if (current.status === "working" || current.status === "blocked") return { status: action === "stop" ? "STOPPED" : "QUEUED", pipelineId, communicationFile: progress.state.communicationFile, targetStageId: selected?.stageId, controlId };
		return { status: "BLOCKED", pipelineId, communicationFile: progress.state.communicationFile, targetStageId: selected?.stageId, controlId, error: "Coordinator transport state is unknown; control was persisted but not relayed" };
		});
	}

	/** Compatibility answer wrapper targeting one blocked stage when supplied. */
	async answer(pipelineId: string, answer: string, projectRoot: string, workspaceId: string, signal?: AbortSignal, target?: PipelineControlTarget): Promise<PipelineControlResult> {
		return this.control(pipelineId, "answer", projectRoot, workspaceId, { answer, target }, signal);
	}

	/** Persists an approval control for one waiting repair/stage target. */
	async approve(pipelineId: string, projectRoot: string, workspaceId: string, target: PipelineControlTarget, planHash?: string, signal?: AbortSignal): Promise<PipelineControlResult> {
		return this.control(pipelineId, "approve", projectRoot, workspaceId, { target, planHash }, signal);
	}

	/** Persists a rejection control without treating it as an ordinary answer. */
	async reject(pipelineId: string, projectRoot: string, workspaceId: string, target: PipelineControlTarget, planHash?: string, signal?: AbortSignal): Promise<PipelineControlResult> {
		return this.control(pipelineId, "reject", projectRoot, workspaceId, { target, planHash }, signal);
	}

	/** Persists a pipeline-scoped stop control and lets the active-run poller cancel children. */
	async stop(pipelineId: string, projectRoot: string, workspaceId: string, signal?: AbortSignal): Promise<PipelineControlResult> {
		const progress = await this.dependencies.pipelineStore.readProgress(pipelineId, this.dependencies.config.pipelines.default.maxStages);
		if (progress.state.status === "DONE" || progress.state.status === "STOPPED" || progress.stopRequested) return { status: progress.state.status === "DONE" ? "DONE" : "STOPPED", pipelineId, communicationFile: progress.state.communicationFile };
		return this.control(pipelineId, "stop", projectRoot, workspaceId, {}, signal);
	}

	/** Requests exact recovery of one unfinished pipeline stage and wakes the coordinator when safe.
	 *
	 * @param pipelineId Path-safe pipeline identifier.
	 * @param projectRoot Project root containing the pipeline state.
	 * @param workspaceId Herdr workspace bound to the coordinator.
	 * @param sourcePaneId Current parent pane used only when exact coordinator recovery needs a split source.
	 * @param cwd Working directory used by an exact coordinator restart.
	 * @param signal Optional cancellation signal.
	 * @returns Durable recovery control result.
	 */
	async recover(pipelineId: string, projectRoot: string, workspaceId: string, sourcePaneId: string, cwd: string, signal?: AbortSignal, target?: PipelineControlTarget): Promise<PipelineControlResult> {
		return this.dependencies.pipelineStore.coordinatorStore.withExecutionLock(async () => {
			const store = this.dependencies.pipelineStore.coordinatorStore;
			const current = await store.read();
			if (!current) return { status: "BLOCKED", pipelineId, error: "No coordinator binding exists; exact recovery cannot create a fresh coordinator" };
			let binding: CoordinatorBinding;
			try {
				binding = (await this.ensure(projectRoot, workspaceId, sourcePaneId, cwd, signal)).binding;
			} catch (error) {
				return { status: "BLOCKED", pipelineId, error: error instanceof Error ? error.message : String(error) };
			}
			const progress = await this.dependencies.pipelineStore.readProgress(pipelineId, this.dependencies.config.pipelines.default.maxStages, binding.writerFence);
			const candidates = progress.stages.filter((item) => item.status === "PARTIAL" || item.status === "ERROR" || item.status === "BLOCKED");
			const stage = candidates.find((item) => !target?.stageId || item.stageId === target.stageId);
			if (!target?.stageId && candidates.length > 1) return { status: "BLOCKED", pipelineId, communicationFile: progress.state.communicationFile, error: "recover requires an explicit target stage when multiple stages are unfinished" };
			if (!stage) return { status: "ERROR", pipelineId, communicationFile: progress.state.communicationFile, error: "pipeline has no unfinished stage eligible for exact recovery" };
			if (!stage.communicationFile || !stage.paneId || !stage.agent || !stage.agentSession) {
				return { status: "BLOCKED", pipelineId, communicationFile: progress.state.communicationFile, currentStage: stage.role, error: "stage lacks exact communication, pane, agent, or session identity for recovery" };
			}
			const messageId = `recovery-${pipelineId}-${stage.stageId}-${randomUUID()}`;
			const appended = await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "pipeline.control", "parent", {
				controlId: messageId,
				action: "recover",
				targetScope: "pipeline",
				targetStageIds: [stage.stageId],
				pipelineFence: binding.writerFence ?? `${binding.agentSession.source}:${binding.agentSession.value}`,
				expected: [{ stageId: stage.stageId, attempt: stage.attempt, fencingToken: stage.fencingToken }],
				direction: "parent-to-coordinator",
				previousCommunication: stage.communicationFile,
				previousPaneId: stage.paneId,
				previousAgent: stage.agent,
				previousSession: stage.agentSession,
			}, messageId, { stageId: stage.stageId, stageRole: stage.role, stageOccurrence: stage.stageIndex + 1, attempt: stage.attempt, fencingToken: stage.fencingToken, agentSession: stage.agentSession, schemaVersion: 2 });
			const coordinatorSnapshot = await this.dependencies.gateway.getAgent(binding.agent, signal);
			if (coordinatorSnapshot.status === "idle" || coordinatorSnapshot.status === "done") {
				await this.promptControl(binding, progress.state.communicationFile, appended, "pipeline-recover", signal);
				return { status: "ACCEPTED", pipelineId, communicationFile: progress.state.communicationFile, currentStage: stage.role };
			}
			if (coordinatorSnapshot.status === "working" || coordinatorSnapshot.status === "blocked") return { status: "QUEUED", pipelineId, communicationFile: progress.state.communicationFile, currentStage: stage.role };
			return { status: "BLOCKED", pipelineId, communicationFile: progress.state.communicationFile, currentStage: stage.role, error: "Coordinator transport state is unknown; recovery was persisted but not relayed" };
		});
	}


	async tickCurrent(projectRoot: string, workspaceId: string, callerPaneId: string, callerSession: SessionIdentity, signal?: AbortSignal): Promise<PipelineControlResult> {
		const binding = await this.existingBinding(projectRoot, workspaceId, signal);
		if (binding.paneId !== callerPaneId || !sameSession(binding.agentSession, callerSession)) return { status: "BLOCKED", error: "pipeline.coordinator requires the exact coordinator pane and session" };
		return this.tick(binding, signal);
	}

	/** Sends a fixed JSONL event pointer to an idle coordinator without copying task text. */
	private async promptControl(binding: CoordinatorBinding, communicationFile: string, appended: { lineStart: number; lineEnd: number; lineCount: number; event: { messageId?: string } }, messageType: string, signal?: AbortSignal): Promise<void> {
		const relay = [
			`EVENT LOG: ${communicationFile}`,
			`MESSAGE SEQ: ${appended.lineStart}`,
			`MESSAGE LINES: ${appended.lineStart}-${appended.lineEnd}`,
			`MESSAGE LINE COUNT: ${appended.lineCount}`,
			`MESSAGE ID: ${appended.event.messageId ?? "none"}`,
			`MESSAGE TYPE: ${messageType}`,
			"",
			"Read and replay this JSONL event before acting. Do not interleave prompts while working.",
		].join("\n");
		await this.dependencies.gateway.prompt({ target: binding.agent, text: relay, wait: false, signal });
	}

	private createLeafEngine(): DelegateEngine {
		return new DelegateEngine({
			gateway: this.dependencies.gateway,
			config: this.dependencies.config,
			communicationDirectory: join(this.dependencies.pipelineStore.coordinatorStore.stateDirectory, "communications"),
			capabilities: this.dependencies.capabilities,
			id: this.dependencies.id,
		});
	}

	/** Claims a bounded ready wave, then executes it without holding the global lock. */
	async tick(binding: CoordinatorBinding, signal?: AbortSignal): Promise<PipelineControlResult> {
		await debug.log("coordinator.tick.start", { paneId: binding.paneId, agent: binding.agent, workspaceId: binding.workspaceId, agentSession: binding.agentSession, signalAborted: signal?.aborted ?? false }, "debug");
		if (signal?.aborted) return { status: "PARTIAL", error: "coordinator tick was aborted" };
		const claims = await this.claimReadyStages(binding, signal);
		if (claims.error) return claims.error;
		if (claims.stages.length === 0) return claims.deferred ?? { status: "ACCEPTED", stagesProcessed: 0 };
		const controllers = claims.stages.map((claim) => {
			const controller = new AbortController();
			if (signal) {
				if (signal.aborted) controller.abort(signal.reason);
				else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
			}
			const run: ActiveStageRun = { pipelineId: claim.entry.pipelineId, stageId: claim.stageId, attempt: claim.attempt, fencingToken: claim.fencingToken, reservationId: claim.reservationId, controller, ownerEpoch: claim.ownerEpoch, deadlineAt: claim.deadlineAt };
			this.activeRuns.set(activeRunKey(run.pipelineId, run.stageId), run);
			return { claim, controller };
		});
		const pollMs = this.dependencies.config.pipelines.default.concurrency.controlPollMs;
		const poller = setInterval(() => { void this.pollActiveControls(); }, pollMs);
		poller.unref?.();
		try {
			const results = await Promise.all(controllers.map(({ claim, controller }) => this.executeClaimedStage(binding, claim, controller.signal)));
			const failure = results.find((result) => ["ERROR", "PARTIAL", "BLOCKED", "STOPPED"].includes(result.status));
			if (failure) return failure;
			const pipelineIds = [...new Set(controllers.map(({ claim }) => claim.entry.pipelineId))];
			const latest = await Promise.all(pipelineIds.map((pipelineId) => this.dependencies.pipelineStore.readProgress(pipelineId, this.dependencies.config.pipelines.default.maxStages, binding.writerFence)));
			const allDone = latest.length > 0 && latest.every((progress) => progress.stages.length > 0 && progress.stages.every((stage) => stage.status === "DONE"));
			return {
				status: allDone ? "DONE" : "RUNNING",
				pipelineId: pipelineIds[0],
				communicationFile: latest[0]?.state.communicationFile,
				stagesProcessed: results.length,
			};
		} finally {
			clearInterval(poller);
			for (const { claim } of controllers) this.activeRuns.delete(activeRunKey(claim.entry.pipelineId, claim.stageId));
		}
	}

	/** Claims ready stages under the short execution lock and records durable leases. */
	private async claimReadyStages(binding: CoordinatorBinding, signal?: AbortSignal): Promise<{ stages: ClaimedStage[]; deferred?: PipelineControlResult; error?: PipelineControlResult }> {
		const store = this.dependencies.pipelineStore.coordinatorStore;
		return store.withExecutionLock(async () => {
			const current = await store.read();
			if (!current || !sameBinding(current, binding)) return { stages: [], error: { status: "BLOCKED", error: "coordinator binding/session does not match the current exact coordinator" } };
			const currentAgent = await this.dependencies.gateway.getAgent(binding.agent, signal);
			if (!currentAgent.agentSession || !sameSession(currentAgent.agentSession, binding.agentSession)) return { stages: [], error: { status: "BLOCKED", error: "coordinator exact agent_session is missing or mismatched" } };
			const policy = this.dependencies.config.pipelines.default.concurrency;
			const inbox = await this.dependencies.pipelineStore.readInbox();
			const validReservationIds = new Set<string>([...this.activeRuns.values()].map((run) => run.reservationId));
			for (const entry of inbox) {
				try {
					const progress = await this.dependencies.pipelineStore.readProgress(entry.pipelineId, this.dependencies.config.pipelines.default.maxStages, binding.writerFence);
					for (const stage of progress.stages) if (stage.reservationId && ["RUNNING", "BLOCKED"].includes(stage.status)) validReservationIds.add(stage.reservationId);
				} catch {
					// The normal per-entry replay below records malformed pipeline state; reconciliation remains fail-closed here.
				}
			}
			await this.ledger.reconcile(validReservationIds);
			const activeReservations = await this.ledger.active();
			const activePipelineIds = new Set(activeReservations.filter((item) => item.reservedSlots > 0).map((item) => item.pipelineId));
			const usedSlots = activeReservations.reduce((sum, item) => sum + item.reservedSlots, 0);

			const claims: ClaimedStage[] = [];
			let deferred: PipelineControlResult | undefined;
			for (const entry of inbox) {
				if (claims.length >= policy.maxAgents - usedSlots) break;
				let progress: PipelineProgress;
				try { progress = await this.dependencies.pipelineStore.readProgress(entry.pipelineId, this.dependencies.config.pipelines.default.maxStages, binding.writerFence); }
				catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "error", "coordinator", { status: "ERROR", error: message }).catch(() => undefined);
					deferred ??= { status: "ERROR", pipelineId: entry.pipelineId, communicationFile: entry.communicationFile, error: message };
					continue;
				}
				if (progress.state.acceptedSeq === undefined) await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "accepted", "coordinator", { queueState: "accepted", direction: "coordinator-to-parent" }, `accepted-${entry.pipelineId}`);
				if (progress.stopRequested || ["DONE", "STOPPED"].includes(progress.state.status)) continue;
				const requestPolicy = progress.request.concurrency ?? policy;
				if (!requestPolicy.enabled && hasExplicitParallelWave(progress.request.stages)) {
					const message = "explicit parallel stages require pipelines.default.concurrency.enabled=true";
					await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "status-changed", "coordinator", { status: "BLOCKED", error: message });
					deferred ??= { status: "BLOCKED", pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, error: message };
					continue;
				}
				if (!activePipelineIds.has(entry.pipelineId) && activePipelineIds.size >= requestPolicy.maxPipelines) {
					deferred ??= { status: "QUEUED", pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, error: "workspace pipeline quota is full" };
					continue;
				}
				const pipelineActive = activeReservations.filter((item) => item.pipelineId === entry.pipelineId && item.reservedSlots > 0).length;
				const pipelineLimit = Math.min(requestPolicy.maxConcurrentStages, ...progress.request.stages.map((stage) => stage.maxConcurrentStages ?? requestPolicy.maxConcurrentStages));
				const ready = progress.stages.filter((stage) => {
					const dependenciesDone = (stage.dependsOn ?? []).every((dependency) => progress.stages.find((candidate) => candidate.stageId === dependency)?.status === "DONE");
					const freshAnswer = stage.status === "BLOCKED" && stage.answerSeq !== undefined && stage.answerSeq > stage.lastOutcomeSeq;
					const freshRecovery = ["PARTIAL", "ERROR"].includes(stage.status) && stage.recoverySeq !== undefined && stage.recoverySeq > stage.lastOutcomeSeq;
					return dependenciesDone && (stage.status === "QUEUED" || freshAnswer || freshRecovery);
				});
				for (const stage of ready) {
					if (claims.length >= requestPolicy.maxAgents || pipelineActive + claims.filter((claim) => claim.entry.pipelineId === entry.pipelineId).length >= pipelineLimit) break;
					const stageIndex = stage.stageIndex;
					const input = progress.request.stages[stageIndex]!;
					let stageCwd: string;
					let resourceKeys: readonly string[];
					try {
						stageCwd = await resolveStageCwd(store.projectRoot, input.cwd ?? binding.cwd);
						resourceKeys = await resolveStageResources(store.projectRoot, stageCwd, input.resourceKeys);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "status-changed", "coordinator", { status: "BLOCKED", stageIndex, stageId: stage.stageId, stageRole: stage.role, error: message }, undefined, { stageId: stage.stageId, stageRole: stage.role, stageOccurrence: stageIndex + 1, schemaVersion: 2 }).catch(() => undefined);
						deferred ??= { status: "BLOCKED", pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, currentStage: stage.role, error: message };
						continue;
					}
					if (!resourceKeys.length) {
						const message = "stage resource ownership cannot be proven";
						await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "status-changed", "coordinator", { status: "BLOCKED", stageIndex, stageId: stage.stageId, stageRole: stage.role, error: message }, undefined, { stageId: stage.stageId, stageRole: stage.role, stageOccurrence: stageIndex + 1, schemaVersion: 2 }).catch(() => undefined);
						deferred ??= { status: "BLOCKED", pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, currentStage: stage.role, error: message };
						continue;
					}
					const profile = resolveAgentProfile(this.dependencies.config, input.role, { agent: input.agent, effort: input.effort, extraArgs: input.extraArgs, cwd: stageCwd, timeoutMs: input.timeoutMs, panePolicy: input.panePolicy }, this.dependencies.capabilities);
					const now = Date.now();
					const resolvedTimeoutMs = profile.timeoutMs;
					const deadlineAt = new Date(now + resolvedTimeoutMs + requestPolicy.startupGraceMs + requestPolicy.captureGraceMs + requestPolicy.controlMarginMs).toISOString();
					const reservationId = `reservation-${entry.pipelineId}-${stage.stageId}-${(this.dependencies.id ?? (() => randomUUID().slice(0, 8)))()}`;
					const attempt = (stage.attempt ?? 0) + 1;
					const ownerEpoch = binding.writerFence ?? `${binding.agentSession.source}:${binding.agentSession.value}`;
					const fencingToken = `${ownerEpoch}:${stage.stageId}:${attempt}:${randomUUID()}`;
					const expiresAt = new Date(now + Math.max(requestPolicy.leaseTtlMs, resolvedTimeoutMs + requestPolicy.startupGraceMs + requestPolicy.captureGraceMs + requestPolicy.controlMarginMs)).toISOString();
					if (stage.communicationFile && !(await isWorkspaceStageCommunicationFile(stage.communicationFile, store.stateDirectory))) {
						const message = "stage communication file is outside the current workspace";
						await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "status-changed", "coordinator", { status: "BLOCKED", stageIndex, stageId: stage.stageId, stageRole: stage.role, error: message }, undefined, { stageId: stage.stageId, stageRole: stage.role, stageOccurrence: stageIndex + 1, schemaVersion: 2 }).catch(() => undefined);
						deferred ??= { status: "BLOCKED", pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, currentStage: stage.role, error: message };
						continue;
					}
					const reservation = await this.ledger.claim({ reservationId, pipelineId: entry.pipelineId, stageId: stage.stageId, attempt, fencingToken, reservedSlots: 1, expiresAt, access: input.access ?? "workspace-write", resourceKeys, ownerEpoch }, { maxAgents: requestPolicy.maxAgents });
					if (!reservation.committed || !reservation.reservation) {
						deferred ??= { status: "QUEUED", pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, currentStage: stage.role, error: reservation.reason === "resource-conflict" ? "stage resource conflict" : "coordinator worker quota is full" };
						continue;
					}
					const stageCommunicationFile = stage.communicationFile ?? join(this.dependencies.pipelineStore.coordinatorStore.stateDirectory, "communications", `${entry.pipelineId}-${stage.stageId}-attempt-${attempt}.jsonl`);
					try {
						if (!stage.communicationFile) await createEventLog(stageCommunicationFile);
						await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "stage-claimed", "coordinator", { status: "RUNNING", stageIndex, stageRole: stage.role, stageId: stage.stageId, attempt, fencingToken, reservationId, resourceKeys, access: input.access ?? "workspace-write", deadlineAt, expiresAt, communicationFile: stageCommunicationFile, cwd: stageCwd }, undefined, { stageId: stage.stageId, stageRole: stage.role, stageOccurrence: stageIndex + 1, attempt, fencingToken, schemaVersion: 2 });
						await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "stage-started", "coordinator", { status: "RUNNING", stageIndex, stageRole: stage.role, stageId: stage.stageId, attempt, fencingToken, reservationId, communicationFile: stageCommunicationFile, deadlineAt, cwd: stageCwd }, undefined, { stageId: stage.stageId, stageRole: stage.role, stageOccurrence: stageIndex + 1, attempt, fencingToken, schemaVersion: 2 });
					} catch (error) {
						await this.ledger.release(reservationId, ownerEpoch, fencingToken).catch(() => undefined);
						throw error;
					}
					claims.push({ progress: { ...progress, request: { ...progress.request, stages: progress.request.stages.map((candidate, index) => index === stageIndex ? { ...candidate, stageId: stage.stageId, dependsOn: stage.dependsOn ?? [], resourceKeys, cwd: stageCwd } : candidate) } }, entry, stageIndex, stageId: stage.stageId!, attempt, fencingToken, reservationId, ownerEpoch, deadlineAt, resourceKeys });
					activePipelineIds.add(entry.pipelineId);
				}
				if (claims.length > 0 && requestPolicy.maxPipelines <= 1) break;
			}
			const projection = await this.ledger.active();
			await store.updateReservations(toBindingReservations(projection), binding.writerFence);
			return { stages: claims, deferred };
		});
	}

	/** Executes one claimed stage outside the coordinator execution lock. */
	private async executeClaimedStage(binding: CoordinatorBinding, claim: ClaimedStage, signal: AbortSignal): Promise<PipelineControlResult> {
		const stage = claim.progress.stages[claim.stageIndex]!;
		const input = claim.progress.request.stages[claim.stageIndex]!;
		const task = input.task ?? claim.progress.request.task;
		const heartbeatMs = this.dependencies.config.pipelines.default.concurrency.heartbeatMs;
		const heartbeatTimer = setInterval(() => {
			void this.ledger.heartbeat(claim.reservationId, claim.ownerEpoch, new Date(Date.parse(claim.deadlineAt) + this.dependencies.config.pipelines.default.concurrency.leaseTtlMs).toISOString())
				.then((renewed) => renewed ? this.dependencies.pipelineStore.appendPipelineEvent(claim.entry.pipelineId, "stage-heartbeat", "coordinator", { stageId: claim.stageId, stageIndex: claim.stageIndex, attempt: claim.attempt, fencingToken: claim.fencingToken, reservationId: claim.reservationId, lastHeartbeatAt: new Date().toISOString() }, undefined, { stageId: claim.stageId, stageRole: stage.role, stageOccurrence: claim.stageIndex + 1, attempt: claim.attempt, fencingToken: claim.fencingToken, schemaVersion: 2 }) : undefined)
				.catch(() => undefined);
		}, heartbeatMs);
		heartbeatTimer.unref?.();
		try {
			let result: Awaited<ReturnType<DelegateEngine["run"]>>;
		try {
			result = await this.createLeafEngine().run({
			action: "delegate",
			task,
			role: input.role,
			overrides: { agent: input.agent, effort: input.effort, extraArgs: input.extraArgs, cwd: input.cwd ?? binding.cwd, timeoutMs: input.timeoutMs, panePolicy: input.panePolicy ?? claim.progress.request.panePolicy },
			transaction: claim.entry.pipelineId,
			stageOccurrence: claim.stageIndex + 1,
			previousCommunication: stage.communicationFile,
			communicationFile: stage.communicationFile ?? join(this.dependencies.pipelineStore.coordinatorStore.stateDirectory, "communications", `${claim.entry.pipelineId}-${claim.stageId}-attempt-${claim.attempt}.jsonl`),
			previousPaneId: stage.paneId,
			previousAgent: stage.agent,
			continuation: stage.answer,
			previousSession: stage.agentSession,
			deadlineAt: claim.deadlineAt,
			attempt: claim.attempt,
			fencingToken: claim.fencingToken,
			resourceKeys: claim.resourceKeys,
			access: input.access ?? "workspace-write",
		}, {
			cwd: input.cwd ?? binding.cwd,
			workspaceId: binding.workspaceId,
			sourcePaneId: binding.paneId,
			executionOwner: "coordinator",
			layoutLock: (callback) => this.dependencies.pipelineStore.coordinatorStore.withLayoutLock(callback),
			resourceKeys: claim.resourceKeys,
			access: input.access ?? "workspace-write",
			}, signal);
		} catch (error) {
			// Convert stage-start and gateway failures into a durable result so the reservation can be released through the normal commit path.
			result = {
				status: "ERROR",
				communicationId: `${claim.entry.pipelineId}-${claim.stageId}-attempt-${claim.attempt}`,
				communicationFile: stage.communicationFile ?? join(this.dependencies.pipelineStore.coordinatorStore.stateDirectory, "communications", `${claim.entry.pipelineId}-${claim.stageId}-attempt-${claim.attempt}.jsonl`),
				paneId: stage.paneId,
				agent: stage.agent,
				agentSession: stage.agentSession,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		try {
			return await this.commitStageResult(claim, result);
		} catch (error) {
			// A commit-side append failure must not strand the claimed reservation or its worker quota.
			await this.ledger.release(claim.reservationId, claim.ownerEpoch, claim.fencingToken).catch(() => undefined);
			await this.dependencies.pipelineStore.appendPipelineEvent(claim.entry.pipelineId, "error", "coordinator", {
				status: "ERROR",
				stageId: claim.stageId,
				stageIndex: claim.stageIndex,
				attempt: claim.attempt,
				fencingToken: claim.fencingToken,
				error: error instanceof Error ? error.message : String(error),
			}).catch(() => undefined);
			throw error;
		}
		} finally {
			clearInterval(heartbeatTimer);
		}
	}

	/** Commits a stage result only when the attempt/fence still owns the replayed stage. */
	private async commitStageResult(claim: ClaimedStage, result: Awaited<ReturnType<DelegateEngine["run"]>>): Promise<PipelineControlResult> {
		return this.dependencies.pipelineStore.coordinatorStore.withExecutionLock(async () => {
			const progress = await this.dependencies.pipelineStore.readProgress(claim.entry.pipelineId, this.dependencies.config.pipelines.default.maxStages, claim.ownerEpoch);
			const currentBinding = await this.dependencies.pipelineStore.coordinatorStore.read();
			const current = progress.stages.find((stage) => stage.stageId === claim.stageId);
			if (!current || current.attempt !== claim.attempt || current.fencingToken !== claim.fencingToken || currentBinding?.writerFence !== claim.ownerEpoch || progress.stopRequested) {
				await this.dependencies.pipelineStore.appendPipelineEvent(claim.entry.pipelineId, "stale-attempt-diagnostic", "coordinator", { status: "PARTIAL", stageId: claim.stageId, attempt: claim.attempt, fencingToken: claim.fencingToken, reason: progress.stopRequested ? "control-cancelled" : "attempt-or-fence-mismatch" }, undefined, { stageId: claim.stageId, stageRole: current?.role ?? "unknown", stageOccurrence: claim.stageIndex + 1, attempt: claim.attempt, fencingToken: claim.fencingToken, schemaVersion: 2 });
				await this.ledger.release(claim.reservationId, claim.ownerEpoch, claim.fencingToken);
				return { status: progress.stopRequested ? "STOPPED" : "PARTIAL", pipelineId: claim.entry.pipelineId, communicationFile: progress.state.communicationFile, currentStage: current?.role, stagesProcessed: 1, error: "stage result was stale or cancelled" };
			}
			const finalStatus = result.status === "DONE" ? "DONE" : result.status;
			await this.dependencies.pipelineStore.appendPipelineEvent(claim.entry.pipelineId, "result", "coordinator", { status: finalStatus, stageIndex: claim.stageIndex, stageId: claim.stageId, stageRole: current.role, attempt: claim.attempt, fencingToken: claim.fencingToken, communicationFile: result.communicationFile, paneId: result.paneId, agent: result.agent, summary: result.completion?.summary ?? result.error, error: result.status === "ERROR" ? result.error : undefined, accepted: result.status !== "PARTIAL" ? true : "unknown", operation: "wait" }, undefined, { stageId: claim.stageId, stageRole: current.role, stageOccurrence: claim.stageIndex + 1, attempt: claim.attempt, fencingToken: claim.fencingToken, agentSession: result.agentSession, schemaVersion: 2 });
			await this.dependencies.pipelineStore.appendPipelineEvent(claim.entry.pipelineId, "stage-released", "coordinator", { status: finalStatus, detailStatus: finalStatus === "BLOCKED" ? "WAITING_FOR_ANSWER" : finalStatus === "PARTIAL" && result.error?.includes("aborted") ? "CANCELLED" : finalStatus, stageIndex: claim.stageIndex, stageId: claim.stageId, attempt: claim.attempt, fencingToken: claim.fencingToken, reservationId: claim.reservationId, summary: result.completion?.summary ?? result.error }, undefined, { stageId: claim.stageId, stageRole: current.role, stageOccurrence: claim.stageIndex + 1, attempt: claim.attempt, fencingToken: claim.fencingToken, agentSession: result.agentSession, schemaVersion: 2 });
			await this.ledger.release(claim.reservationId, claim.ownerEpoch, claim.fencingToken);
			await this.dependencies.pipelineStore.coordinatorStore.updateReservations(toBindingReservations(await this.ledger.active()), claim.ownerEpoch);
			const latest = await this.dependencies.pipelineStore.readProgress(claim.entry.pipelineId, this.dependencies.config.pipelines.default.maxStages, claim.ownerEpoch);
			if (result.status !== "DONE") {
				await this.dependencies.pipelineStore.appendPipelineEvent(claim.entry.pipelineId, "status-changed", "coordinator", { status: finalStatus, currentStage: current.role, stageId: claim.stageId, stageIndex: claim.stageIndex, summary: result.completion?.summary ?? result.error, error: result.error }, undefined, { stageId: claim.stageId, stageRole: current.role, stageOccurrence: claim.stageIndex + 1, attempt: claim.attempt, fencingToken: claim.fencingToken, schemaVersion: 2 });
				return { status: finalStatus, pipelineId: claim.entry.pipelineId, communicationFile: latest.state.communicationFile, stagesProcessed: 1, currentStage: current.role, error: result.error, targetStageId: claim.stageId };
			}
			const allDone = latest.stages.every((stage) => stage.status === "DONE");
			if (allDone) await this.dependencies.pipelineStore.appendPipelineEvent(claim.entry.pipelineId, "result", "coordinator", { status: "DONE", summary: "all pipeline stages completed" });
			else await this.dependencies.pipelineStore.appendPipelineEvent(claim.entry.pipelineId, "status-changed", "coordinator", { status: "RUNNING", currentStage: latest.stages.find((stage) => stage.status !== "DONE")?.role });
			return { status: allDone ? "DONE" : "RUNNING", pipelineId: claim.entry.pipelineId, communicationFile: latest.state.communicationFile, stagesProcessed: 1, targetStageId: claim.stageId };
		});
	}

	/** Polls durable control events and cancels only matching active stage controllers. */
	private async pollActiveControls(): Promise<void> {
		for (const run of this.activeRuns.values()) {
			try {
				const progress = await this.dependencies.pipelineStore.readProgress(run.pipelineId, this.dependencies.config.pipelines.default.maxStages, run.ownerEpoch);
				const stage = progress.stages.find((candidate) => candidate.stageId === run.stageId);
				if (progress.stopRequested || stage?.detailStatus === "CANCELLED") run.controller.abort(new Error("durable pipeline control requested cancellation"));
				if (this.dependencies.config.pipelines.default.concurrency.failFast && stage && ["ERROR", "PARTIAL", "BLOCKED"].includes(stage.status)) {
					for (const sibling of this.activeRuns.values()) if (sibling.pipelineId === run.pipelineId && sibling.stageId !== run.stageId) sibling.controller.abort(new Error("fail-fast sibling cancellation"));
				}
				if (Date.parse(run.deadlineAt) <= Date.now()) run.controller.abort(new Error("stage deadline expired"));
			} catch {
				// A corrupt or unavailable control read must not make an active child unsafe to retry.
			}
		}
	}

	/** Compatibility serial executor retained as a narrow wrapper around the claim path. */
	private async executePipeline(binding: CoordinatorBinding, _pipelineId: string, _progress: PipelineProgress, signal?: AbortSignal): Promise<PipelineControlResult> {
		const claims = await this.claimReadyStages(binding, signal);
		if (claims.error) return claims.error;
		if (claims.stages.length === 0) return claims.deferred ?? { status: "ACCEPTED", stagesProcessed: 0 };
		const results = await Promise.all(claims.stages.map((claim) => this.executeClaimedStage(binding, claim, signal ?? new AbortController().signal)));
		return results[0] ?? { status: "ACCEPTED", stagesProcessed: 0 };
	}
	/** Returns durable pipeline status without polling stage panes. */
	async status(pipelineId: string): Promise<ReturnType<PipelineStore["readState"]>> {
		return this.dependencies.pipelineStore.readState(pipelineId);
	}

	/** Returns replayed pipeline and per-stage progress for parent UI monitoring. */
	async progress(pipelineId: string): Promise<PipelineProgress> {
		return this.dependencies.pipelineStore.readProgress(pipelineId, this.dependencies.config.pipelines.default.maxStages);
	}
}

/** Produces a stable in-memory key for one active stage controller. */
function activeRunKey(pipelineId: string, stageId: string): string {
	return `${pipelineId}:${stageId}`;
}

/** Confirms a persisted stage communication log remains inside the workspace state directory. */
async function isWorkspaceStageCommunicationFile(file: string, stateDirectory: string): Promise<boolean> {
	if (!file.endsWith(".jsonl")) return false;
	const root = resolve(join(stateDirectory, "communications"));
	const candidate = resolve(file);
	const pathFromRoot = relative(root, candidate);
	if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`) || isAbsolutePath(pathFromRoot)) return false;
	try {
		const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
		const realRelative = relative(realRoot, realCandidate);
		return Boolean(realRelative) && realRelative !== ".." && !realRelative.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`) && !isAbsolutePath(realRelative);
	} catch {
		return false;
	}
}

/** Detects whether a path is absolute after relative() normalization. */
function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(value);
}

/** Converts live reservation leases into the coordinator binding projection. */
function toBindingReservations(items: readonly ReservationProjection[]): readonly ActivePipelineReservation[] {
	return items
		.filter((item) => item.state === "active" || item.state === "intent" || item.state === "orphan-pending")
		.map((item) => ({
			reservationId: item.reservationId,
			pipelineId: item.pipelineId,
			reservedSlots: item.reservedSlots,
			leaseIds: [item.reservationId],
			reservationEpoch: item.reservationEpoch,
			ownerEpoch: item.ownerEpoch,
		}));
}

/** Detects whether an explicit dependency graph contains a concurrently ready wave. */
function hasExplicitParallelWave(stages: readonly PipelineStageInput[]): boolean {
	if (stages.length < 2 || !stages.some((stage) => stage.dependencyMode === "explicit")) return false;
	const byId = new Map(stages.map((stage, index) => [stage.stageId ?? `stage-${index}`, stage]));
	const remaining = new Set(byId.keys());
	const completed = new Set<string>();
	while (remaining.size > 0) {
		const ready = [...remaining].filter((stageId) => {
			const stage = byId.get(stageId)!;
			return (stage.dependsOn ?? []).every((dependency) => completed.has(dependency));
		});
		if (ready.length > 1) return true;
		if (ready.length === 0) return false;
		completed.add(ready[0]!);
		remaining.delete(ready[0]!);
	}
	return false;
}

/** Resolves a stage cwd under the current project root and rejects symlink/path escapes. */
async function resolveStageCwd(projectRoot: string, cwd: string): Promise<string> {
	const projectKey = await canonicalCwdResourceKey(projectRoot);
	const candidateKey = await canonicalCwdResourceKey(resolve(projectRoot, cwd));
	if (!projectKey || !candidateKey) throw new Error("stage cwd cannot be canonicalized");
	const projectPath = projectKey.slice("cwd:".length);
	const candidatePath = candidateKey.slice("cwd:".length);
	const pathFromProject = relative(projectPath, candidatePath);
	if (pathFromProject === ".." || pathFromProject.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`) || isAbsolutePath(pathFromProject)) throw new Error("stage cwd must remain inside the project root");
	return candidatePath;
}

/** Resolves and canonicalizes declared resources, defaulting to the effective cwd. */
async function resolveStageResources(projectRoot: string, cwd: string, declared: readonly string[] | undefined): Promise<readonly string[]> {
	if (!declared || declared.length === 0) {
		const defaultKey = await canonicalCwdResourceKey(resolve(cwd));
		return defaultKey ? [defaultKey] : [];
	}
	const projectKey = await canonicalCwdResourceKey(projectRoot);
	if (!projectKey) throw new Error("project root resource cannot be canonicalized");
	const projectPath = projectKey.slice("cwd:".length);
	const resources: string[] = [];
	for (const raw of declared) {
		const key = raw.trim();
		if (!key) continue;
		if (key.startsWith("cwd:")) {
			const canonical = await canonicalCwdResourceKey(key.slice("cwd:".length));
			if (!canonical || canonical !== `cwd:${key.slice("cwd:".length)}`) throw new Error(`stage cwd resource key is not canonical: ${key}`);
			const resourcePath = canonical.slice("cwd:".length);
			const relativeResource = relative(projectPath, resourcePath);
			if (relativeResource === ".." || relativeResource.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`) || isAbsolutePath(relativeResource)) throw new Error(`cwd resource key is outside the project root: ${key}`);
			resources.push(canonical);
			continue;
		}
		if (!/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(key)) throw new Error(`stage resource key must be namespaced: ${key}`);
		resources.push(key);
	}
	return [...new Set(resources)];
}

/** Recognizes a Herdr lookup failure that proves the prior coordinator target is closed. */
function isDefinitivelyClosedAgentLookup(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { code?: unknown; message?: unknown; stderr?: unknown };
	if (candidate.code === 404 || candidate.code === "ENOENT") return true;
	const text = [candidate.message, candidate.stderr]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.toLowerCase();
	return text.includes("agent_not_found") || (text.includes("agent target") && text.includes("not found")) || text.includes("not found") || text.includes("unknown agent") || text.includes("no such agent");
}

/** Compares all exact coordinator binding identity fields. */
function sameBinding(left: CoordinatorBinding, right: CoordinatorBinding): boolean {
	return left.projectRoot === right.projectRoot
		&& left.workspaceId === right.workspaceId
		&& left.paneId === right.paneId
		&& left.agent === right.agent
		&& left.schemaVersion === right.schemaVersion
		&& left.schemaEpoch === right.schemaEpoch
		&& left.writerFence === right.writerFence
		&& sameSession(left.agentSession, right.agentSession);
}

/** Compares exact session identity triples. */
function sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
	return left.kind === right.kind && left.source === right.source && left.value === right.value;
}
