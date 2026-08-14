import assert from "node:assert/strict";
import test from "node:test";

import { closedPaneTabLabel, planPaneDisposition, resolvePanePolicy } from "./pane-policy.ts";
import { errorCompletionContract, isSemanticDone, parseCompletionContract } from "./result.ts";

/** Checks completion parsing requires status, summary, and validation evidence. */
test("completion contract parsing distinguishes DONE from incomplete output", () => {
	const done = parseCompletionContract("STATUS: DONE\nSUMMARY: implemented\nVALIDATION: npm test passed\nCHANGED FILES: src/tool.ts");
	assert.equal(done.status, "DONE");
	assert.equal(isSemanticDone(done), true);
	assert.equal(isSemanticDone(parseCompletionContract("STATUS: DONE\nSUMMARY: implemented\nVALIDATION: pending")), true);
	const indented = parseCompletionContract("\n STATUS: DONE\n SUMMARY: rendered through Herdr text snapshot\n VALIDATION: no files changed\n");
	assert.equal(indented.status, "DONE");
	assert.equal(indented.summary, "rendered through Herdr text snapshot");
	assert.equal(isSemanticDone(indented), true);
	const tuiDecorated = parseCompletionContract("• STATUS: DONE\n⏺ SUMMARY: rendered through an agent TUI\n• VALIDATION: no files changed\n");
	assert.equal(tuiDecorated.status, "DONE");
	assert.equal(tuiDecorated.summary, "rendered through an agent TUI");
	assert.equal(isSemanticDone(tuiDecorated), true);
	const arbitraryPrefixes = parseCompletionContract("xSTATUS: DONE\n>>SUMMARY: rendered through arbitrary prefixes\n VALIDATION: no files changed\n");
	assert.equal(arbitraryPrefixes.status, "DONE");
	assert.equal(arbitraryPrefixes.summary, "rendered through arbitrary prefixes");
	assert.equal(isSemanticDone(arbitraryPrefixes), true);
	assert.throws(() => parseCompletionContract("abcSTATUS: DONE\nSUMMARY: too many prefix characters\nVALIDATION: no files changed\n"), /STATUS/);
	assert.equal(errorCompletionContract(new Error("bad")).status, "ERROR");
	assert.throws(() => parseCompletionContract("STATUS: DONE\nSUMMARY: missing validation"), /VALIDATION/);
});

/** Checks pane disposition cannot run before semantic DONE and uses stable labels. */
test("pane policy requires DONE and deterministic communication tab labels", () => {
	assert.equal(resolvePanePolicy(undefined), "new-tab");
	assert.equal(resolvePanePolicy("new-tab", true), "keep");
	assert.deepEqual(planPaneDisposition("new-tab", "worker-test", true), { policy: "new-tab", tabLabel: "closed-pane-worker-test" });
	assert.throws(() => planPaneDisposition("close", "worker-test", false), /semantic DONE/);
	assert.throws(() => closedPaneTabLabel("unsafe id"), /Invalid communicationId/);
});
