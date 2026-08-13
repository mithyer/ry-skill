import type { PaneDispositionResult, PanePolicy } from "./types.ts";

/** Resolves the effective pane policy for a completed leaf stage. */
export function resolvePanePolicy(policy: PanePolicy | undefined, coordinator = false): PanePolicy {
	if (coordinator) return "keep";
	return policy ?? "new-tab";
}

/** Computes the deterministic closed-pane tab label from the communication id. */
export function closedPaneTabLabel(communicationId: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(communicationId)) {
		throw new Error(`Invalid communicationId for pane tab label: ${communicationId}`);
	}
	return `closed-pane-${communicationId}`;
}

/** Plans a pane disposition only after the engine has validated a semantic DONE result. */
export function planPaneDisposition(
	policy: PanePolicy | undefined,
	communicationId: string,
	semanticDone: boolean,
	coordinator = false,
): PaneDispositionResult {
	if (!semanticDone) throw new Error("Pane disposition requires a validated semantic DONE result");
	const resolved = resolvePanePolicy(policy, coordinator);
	return {
		policy: resolved,
		tabLabel: resolved === "new-tab" ? closedPaneTabLabel(communicationId) : undefined,
	};
}
