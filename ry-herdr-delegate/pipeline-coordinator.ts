import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { buildFinalAgentArgs } from "./args.ts";
import { DelegateEngine } from "./engine.ts";
import { resolveAgentProfile, type ConfigCapabilities } from "./config.ts";
import { debug, debugError, hashDebugText } from "./debug.ts";
import { createEventLog } from "./records.ts";
import type {
	CoordinatorBinding,
	DelegateConfig,
	HerdrGateway,
	PipelineControlResult,
	PipelineSubmission,
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

	/**
	 * Creates a persistent coordinator manager.
	 *
	 * @param dependencies Gateway, config, pipeline store, capabilities, and test seams.
	 */
	constructor(dependencies: CoordinatorDependencies) {
		this.dependencies = dependencies;
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
			return this.create(projectRoot, workspaceId, sourcePaneId, cwd);
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
			const snapshot = await this.dependencies.gateway.getAgent(binding.agent);
			if (!snapshot.agentSession || !sameSession(snapshot.agentSession, binding.agentSession)) throw new Error("Coordinator pane remains present but exact session metadata is missing or mismatched");
			if (!snapshot.workspaceId || snapshot.workspaceId !== binding.workspaceId) throw new Error("Coordinator pane belongs to another or unidentified Herdr workspace");
			return undefined;
		} catch (error) {
			if (!isDefinitivelyClosedAgentLookup(error)) throw error;
			const recovered = await this.create(projectRoot, workspaceId, sourcePaneId, cwd, { agent: binding.agent, session: binding.agentSession });
			return recovered.binding;
		}
	}

	/** Creates the coordinator pane, starts Pi, verifies exact session, and publishes binding. */
	private async create(projectRoot: string, workspaceId: string, sourcePaneId: string, cwd: string, resume?: { agent: string; session: SessionIdentity }): Promise<CoordinatorHandle> {
		const store = this.dependencies.pipelineStore.coordinatorStore;
		await debug.log("coordinator.create.start", { projectRoot, workspaceId, sourcePaneId, cwd, resume: Boolean(resume), previousAgent: resume?.agent, previousSession: resume?.session }, "debug");
		const pane = await this.dependencies.gateway.splitPane({ sourcePaneId, direction: "right", cwd, focus: false });
		const profile = resolveAgentProfile(this.dependencies.config, COORDINATOR_ROLE, { agent: "pi" }, this.dependencies.capabilities);
		const agent = resume?.agent ?? `pipeline-coordinator-${(this.dependencies.id ?? (() => randomUUID().slice(0, 8)))()}`;
		const args = buildFinalAgentArgs(profile, resume?.session);
		const started = await this.dependencies.gateway.startAgent({ name: agent, kind: "pi", paneId: pane.paneId, agentArgs: args });
		if (!started.workspaceId || started.workspaceId !== workspaceId) {
			await this.dependencies.gateway.closePane(started.paneId).catch(() => undefined);
			throw new Error("Coordinator start did not return the requested Herdr workspace");
		}
		if (!started.agentSession) throw new Error("Coordinator start did not return exact agent_session metadata");
		if (resume && !sameSession(started.agentSession, resume.session)) {
			await this.dependencies.gateway.closePane(started.paneId).catch(() => undefined);
			throw new Error("Coordinator exact-session recovery returned a different session");
		}
		const binding: CoordinatorBinding = {
			schemaVersion: 1,
			projectRoot,
			workspaceId,
			tabId: started.tabId,
			paneId: started.paneId,
			agent: started.agent,
			cwd,
			agentSession: started.agentSession,
			status: started.status,
			inboxPath: store.inboxPath,
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
			const snapshot = await this.dependencies.gateway.getAgent(binding.agent);
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
	private async sendBootstrap(binding: CoordinatorBinding): Promise<void> {
		const relay = [
			`INBOX FILE: ${binding.inboxPath}`,
			"INBOX FORMAT: JSONL",
			"MESSAGE TYPE: coordinator-bootstrap",
			"",
			COORDINATOR_BOOTSTRAP,
		].join("\n");
		await this.dependencies.gateway.prompt({ target: binding.agent, text: relay, wait: false });
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
		const request = await this.dependencies.pipelineStore.createRequest(input, pipelineId, pipelineId, this.dependencies.config.pipelines.default.maxStages);
		const entry = await this.dependencies.pipelineStore.enqueue({
			schemaVersion: 1,
			pipelineId,
			communicationFile: request.communicationFile,
			messageSeq: request.messageSeq,
			lineStart: request.lineStart,
			lineEnd: request.lineEnd,
			lineCount: request.lineCount,
			queueState: "queued",
			messageId: request.messageId,
			enqueuedAt: new Date().toISOString(),
		});
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
				const current = await this.dependencies.gateway.getAgent(binding.agent);
				if (current.status === "idle" || current.status === "done") {
					await this.promptInbox(binding, entry);
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
	private async promptInbox(binding: CoordinatorBinding, entry: PipelineInboxEntry): Promise<void> {
		const relay = [
			`INBOX FILE: ${binding.inboxPath}`,
			`PIPELINE ID: ${entry.pipelineId}`,
			`INBOX LINE: ${entry.enqueueSeq}`,
			`EVENT LOG: ${entry.communicationFile}`,
			"MESSAGE TYPE: pipeline-queued",
			"",
			"Read this inbox entry and acknowledge it by appending an accepted event to the pipeline JSONL event log.",
		].join("\n");
		await this.dependencies.gateway.prompt({ target: binding.agent, text: relay, wait: false });
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


	/** Writes an answer to the blocked stage and wakes only an idle coordinator. */
	async answer(pipelineId: string, answer: string, projectRoot: string, workspaceId: string, signal?: AbortSignal): Promise<PipelineControlResult> {
		return this.dependencies.pipelineStore.coordinatorStore.withExecutionLock(() => this.answerUnlocked(pipelineId, answer, projectRoot, workspaceId, signal));
	}

	/** Persists an answer while the coordinator execution lock is held. */
	private async answerUnlocked(pipelineId: string, answer: string, projectRoot: string, workspaceId: string, signal?: AbortSignal): Promise<PipelineControlResult> {
		if (!answer.trim()) return { status: "ERROR", pipelineId, error: "pipeline.answer requires a non-empty answer" };
		const binding = await this.existingBinding(projectRoot, workspaceId, signal);
		const progress = await this.dependencies.pipelineStore.readProgress(pipelineId, this.dependencies.config.pipelines.default.maxStages);
		const stage = progress.stages.find((item) => item.status === "BLOCKED");
		if (!stage) return { status: "ERROR", pipelineId, communicationFile: progress.state.communicationFile, error: "pipeline has no blocked stage awaiting an answer" };
		const messageId = `answer-${pipelineId}-${randomUUID()}`;
		const appended = await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "continuation", "parent", {
			stageIndex: stage.stageIndex,
			stageRole: stage.role,
			answer,
			direction: "parent-to-coordinator",
		}, messageId, { stageRole: stage.role, stageOccurrence: stage.stageIndex + 1, agentSession: stage.agentSession });
		const current = await this.dependencies.gateway.getAgent(binding.agent);
		if (current.status === "idle" || current.status === "done") {
			await this.promptControl(binding, progress.state.communicationFile, appended, "pipeline-answer");
			return { status: "ACCEPTED", pipelineId, communicationFile: progress.state.communicationFile };
		}
		if (current.status === "working" || current.status === "blocked") return { status: "QUEUED", pipelineId, communicationFile: progress.state.communicationFile };
		return { status: "BLOCKED", pipelineId, communicationFile: progress.state.communicationFile, error: "Coordinator transport state is unknown; answer was persisted but not relayed" };
	}

	/** Persists a stop request and optionally wakes the idle coordinator. */
	async stop(pipelineId: string, projectRoot: string, workspaceId: string, signal?: AbortSignal): Promise<PipelineControlResult> {
		return this.dependencies.pipelineStore.coordinatorStore.withExecutionLock(() => this.stopUnlocked(pipelineId, projectRoot, workspaceId, signal));
	}

	/** Persists a stop request while the coordinator execution lock is held. */
	private async stopUnlocked(pipelineId: string, projectRoot: string, workspaceId: string, signal?: AbortSignal): Promise<PipelineControlResult> {
		const binding = await this.existingBinding(projectRoot, workspaceId, signal);
		const progress = await this.dependencies.pipelineStore.readProgress(pipelineId, this.dependencies.config.pipelines.default.maxStages);
		if (progress.state.status === "DONE" || progress.state.status === "STOPPED" || progress.stopRequested) return { status: progress.state.status === "DONE" ? "DONE" : "STOPPED", pipelineId, communicationFile: progress.state.communicationFile };
		const appended = await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "status-changed", "parent", {
			status: "STOPPED",
			reason: "parent requested pipeline stop",
			direction: "parent-to-coordinator",
		});
		const current = await this.dependencies.gateway.getAgent(binding.agent);
		if (current.status === "idle" || current.status === "done") await this.promptControl(binding, progress.state.communicationFile, appended, "pipeline-stop");
		return { status: "STOPPED", pipelineId, communicationFile: progress.state.communicationFile };
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
	async recover(pipelineId: string, projectRoot: string, workspaceId: string, sourcePaneId: string, cwd: string, signal?: AbortSignal): Promise<PipelineControlResult> {
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
			const progress = await this.dependencies.pipelineStore.readProgress(pipelineId, this.dependencies.config.pipelines.default.maxStages);
			const stage = progress.stages.find((item) => item.status === "PARTIAL" || item.status === "ERROR" || item.status === "BLOCKED");
			if (!stage) return { status: "ERROR", pipelineId, communicationFile: progress.state.communicationFile, error: "pipeline has no unfinished stage eligible for exact recovery" };
			if (!stage.communicationFile || !stage.paneId || !stage.agent || !stage.agentSession) {
				return { status: "BLOCKED", pipelineId, communicationFile: progress.state.communicationFile, currentStage: stage.role, error: "stage lacks exact communication, pane, agent, or session identity for recovery" };
			}
			const messageId = `recovery-${pipelineId}-${stage.stageIndex}-${randomUUID()}`;
			const appended = await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "recovery", "parent", {
				stageIndex: stage.stageIndex,
				stageRole: stage.role,
				direction: "parent-to-coordinator",
				previousCommunication: stage.communicationFile,
				previousPaneId: stage.paneId,
				previousAgent: stage.agent,
				previousSession: stage.agentSession,
			}, messageId, { stageRole: stage.role, stageOccurrence: stage.stageIndex + 1, agentSession: stage.agentSession });
			const coordinatorSnapshot = await this.dependencies.gateway.getAgent(binding.agent);
			if (coordinatorSnapshot.status === "idle" || coordinatorSnapshot.status === "done") {
				await this.promptControl(binding, progress.state.communicationFile, appended, "pipeline-recover");
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
	private async promptControl(binding: CoordinatorBinding, communicationFile: string, appended: { lineStart: number; lineEnd: number; lineCount: number; event: { messageId?: string } }, messageType: string): Promise<void> {
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
		await this.dependencies.gateway.prompt({ target: binding.agent, text: relay, wait: false });
	}

	private createLeafEngine(): DelegateEngine {
		return new DelegateEngine({
			gateway: this.dependencies.gateway,
			config: this.dependencies.config,
			communicationDirectory: join(this.dependencies.pipelineStore.coordinatorStore.projectRoot, ".pi", "agent", "ry-herdr-delegate", "communications"),
			capabilities: this.dependencies.capabilities,
			id: this.dependencies.id,
		});
	}

	/** Executes at most one queued pipeline serially from durable JSONL state. */
	async tick(binding: CoordinatorBinding, signal?: AbortSignal): Promise<PipelineControlResult> {
		const store = this.dependencies.pipelineStore.coordinatorStore;
		await debug.log("coordinator.tick.start", { paneId: binding.paneId, agent: binding.agent, workspaceId: binding.workspaceId, agentSession: binding.agentSession, signalAborted: signal?.aborted ?? false }, "debug");
		return store.withExecutionLock(async () => {
			if (signal?.aborted) return { status: "PARTIAL", error: "coordinator tick was aborted" };
			const current = await store.read();
			if (!current || !sameBinding(current, binding)) return { status: "BLOCKED", error: "coordinator binding/session does not match the current exact coordinator" };
			const currentAgent = await this.dependencies.gateway.getAgent(binding.agent);
			if (!currentAgent.agentSession || !sameSession(currentAgent.agentSession, binding.agentSession)) return { status: "BLOCKED", error: "coordinator exact agent_session is missing or mismatched" };
			const inbox = await this.dependencies.pipelineStore.readInbox();
			await debug.log("coordinator.tick.inbox", { paneId: binding.paneId, inboxCount: inbox.length }, "trace");
			let deferred: PipelineControlResult | undefined;
			for (const entry of inbox) {
				let progress: PipelineProgress;
				try {
					progress = await this.dependencies.pipelineStore.readProgress(entry.pipelineId, this.dependencies.config.pipelines.default.maxStages);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "error", "coordinator", { status: "ERROR", error: message }).catch(() => undefined);
					deferred ??= { status: "ERROR", pipelineId: entry.pipelineId, communicationFile: entry.communicationFile, error: message };
					continue;
				}
				if (progress.state.acceptedSeq === undefined) {
					await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "accepted", "coordinator", {
						queueState: "accepted",
						direction: "coordinator-to-parent",
					}, `accepted-${entry.pipelineId}`);
				}
				if (progress.stopRequested || ["DONE", "STOPPED"].includes(progress.state.status)) continue;
				if (["ERROR", "PARTIAL"].includes(progress.state.status)) {
					const recoverableStage = progress.stages.find((stage) => stage.status === progress.state.status);
					if (!recoverableStage?.recoverySeq || recoverableStage.recoverySeq <= recoverableStage.lastOutcomeSeq) {
						deferred ??= { status: progress.state.status, pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, error: progress.state.summary };
						continue;
					}
				}
				const blocked = progress.stages.find((stage) => stage.status === "BLOCKED");
				if (blocked && (blocked.answerSeq === undefined || blocked.answerSeq <= blocked.lastOutcomeSeq) && (!blocked.recoverySeq || blocked.recoverySeq <= blocked.lastOutcomeSeq)) {
					deferred ??= { status: "BLOCKED", pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, currentStage: blocked.role, error: blocked.summary ?? "stage is blocked and awaits an answer" };
					continue;
				}
				const running = progress.stages.find((stage) => stage.status === "RUNNING");
				if (running && (!running.communicationFile || !running.agentSession)) {
					deferred ??= { status: "BLOCKED", pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, currentStage: running.role, error: "stage is running without an exact recovery identity" };
					continue;
				}
				try {
					await debug.log("coordinator.tick.execute", { pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, currentStage: progress.state.currentStage, pipelineStatus: progress.state.status }, "debug");
					const result = await this.executePipeline(binding, entry.pipelineId, progress, signal);
					await debug.log("coordinator.tick.result", { pipelineId: entry.pipelineId, status: result.status, currentStage: result.currentStage, stagesProcessed: result.stagesProcessed, communicationFile: result.communicationFile }, result.status === "ERROR" ? "error" : result.status === "PARTIAL" || result.status === "BLOCKED" ? "warn" : "debug");
					return result;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await this.dependencies.pipelineStore.appendPipelineEvent(entry.pipelineId, "error", "coordinator", { status: "ERROR", error: message }).catch(() => undefined);
					deferred ??= { status: "ERROR", pipelineId: entry.pipelineId, communicationFile: progress.state.communicationFile, error: message };
				}
			}
			return deferred ?? { status: "ACCEPTED", stagesProcessed: 0 };
		});
	}

	/** Runs one pipeline's next stage and persists every transition before returning. */
	private async executePipeline(binding: CoordinatorBinding, pipelineId: string, progress: PipelineProgress, signal?: AbortSignal): Promise<PipelineControlResult> {
		const stageIndex = progress.stages.findIndex((stage) => stage.status !== "DONE");
		if (stageIndex < 0) {
			await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "result", "coordinator", { status: "DONE", summary: "all pipeline stages completed" });
			return { status: "DONE", pipelineId, communicationFile: progress.state.communicationFile, stagesProcessed: 0 };
		}
		const stage = progress.stages[stageIndex];
		const input = progress.request.stages[stageIndex];
		const task = input.task ?? progress.request.task;
		await debug.log("coordinator.stage.start", { pipelineId, stageIndex, stageRole: stage.role, stageStatus: stage.status, continuation: Boolean(stage.answer), recoveryAuthorized: Boolean(stage.recoverySeq && stage.recoverySeq > stage.lastOutcomeSeq), task: { length: task.length, sha256: hashDebugText(task) } }, "debug");
		const stageCommunicationFile = stage.communicationFile ?? join(this.dependencies.pipelineStore.coordinatorStore.projectRoot, ".pi", "agent", "ry-herdr-delegate", "communications", `${pipelineId}-stage-${stageIndex}.jsonl`);
		if (!stage.communicationFile) await createEventLog(stageCommunicationFile);
		await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "status-changed", "coordinator", {
			status: "RUNNING",
			currentStage: stage.role,
		});
		await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "status-changed", "coordinator", {
			status: "RUNNING",
			currentStage: stage.role,
			stageIndex,
			communicationFile: stageCommunicationFile,
		}, undefined, { stageRole: stage.role, stageOccurrence: stageIndex + 1, agentSession: stage.agentSession });
		const result = await this.createLeafEngine().run({
			action: "delegate",
			task,
			role: input.role,
			overrides: {
				agent: input.agent,
				effort: input.effort,
				extraArgs: input.extraArgs,
				cwd: input.cwd ?? binding.cwd,
				timeoutMs: input.timeoutMs,
				panePolicy: input.panePolicy ?? progress.request.panePolicy,
			},
			transaction: pipelineId,
			stageOccurrence: stageIndex + 1,
			previousCommunication: stage.communicationFile,
			communicationFile: stageCommunicationFile,
			previousPaneId: stage.paneId,
			previousAgent: stage.agent,
			continuation: stage.answer,
			previousSession: stage.agentSession,
		}, {
			cwd: input.cwd ?? binding.cwd,
			workspaceId: binding.workspaceId,
			sourcePaneId: binding.paneId,
			executionOwner: "coordinator",
		}, signal);
		const finalStatus = result.status === "DONE" ? "DONE" : result.status;
		await debug.log("coordinator.stage.result", { pipelineId, stageIndex, stageRole: stage.role, status: result.status, paneId: result.paneId, agent: result.agent, agentSession: result.agentSession, communicationFile: result.communicationFile, hasCompletion: Boolean(result.completion), error: result.error }, result.status === "ERROR" ? "error" : result.status === "PARTIAL" || result.status === "BLOCKED" ? "warn" : "debug");
		await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "result", "coordinator", {
			status: finalStatus,
			stageIndex,
			stageRole: stage.role,
			communicationFile: result.communicationFile,
			paneId: result.paneId,
			agent: result.agent,
			summary: result.completion?.summary ?? result.error,
			error: result.status === "ERROR" ? result.error : undefined,
		}, undefined, { stageRole: stage.role, stageOccurrence: stageIndex + 1, agentSession: result.agentSession });
		if (result.status !== "DONE") {
			await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "status-changed", "coordinator", {
				status: result.status,
				currentStage: stage.role,
				summary: result.completion?.summary ?? result.error,
				error: result.error,
			});
			return { status: result.status, pipelineId, communicationFile: progress.state.communicationFile, stagesProcessed: 1, currentStage: stage.role, error: result.error };
		}
		const remaining = progress.stages.slice(stageIndex + 1).some((item) => item.status !== "DONE");
		if (remaining) {
			await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "status-changed", "coordinator", {
				status: "RUNNING",
				currentStage: progress.stages[stageIndex + 1]?.role,
			});
		} else {
			await this.dependencies.pipelineStore.appendPipelineEvent(pipelineId, "result", "coordinator", { status: "DONE", summary: "all pipeline stages completed" });
		}
		return { status: remaining ? "RUNNING" : "DONE", pipelineId, communicationFile: progress.state.communicationFile, stagesProcessed: 1 };
	}

	/** Returns durable pipeline status without polling stage panes. */
	async status(pipelineId: string): Promise<ReturnType<PipelineStore["readState"]>> {
		return this.dependencies.pipelineStore.readState(pipelineId);
	}
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
		&& sameSession(left.agentSession, right.agentSession);
}

/** Compares exact session identity triples. */
function sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
	return left.kind === right.kind && left.source === right.source && left.value === right.value;
}
