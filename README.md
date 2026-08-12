# ry-skill

Custom [Pi](https://pi.dev) skills and extensions for fast
[Herdr](https://herdr.dev) workflows.

## Install

From npm:

```bash
pi install npm:ry-skill
```

From GitHub:

```bash
pi install git:github.com/mithyer/ry-skill
```

## Herdr integration

This package has two deliberately separate Herdr integration paths:

- `ry-herdr-fork` and `ry-herdr-clone` invoke the standalone `herdr` CLI because they create tabs and launch independent Pi sessions. The `@ogulcancelik/pi-herdr` package is useful for structured layout, pane, and agent tools, but it is not their runtime dependency.
- `ry-herdr-delegate` requires the exact `herdr_delegate` tool from [`@andrewjacop/pi-herdr`](https://www.npmjs.com/package/@andrewjacop/pi-herdr). It does not use `@ogulcancelik/pi-herdr`'s `herdr_layout`, `herdr_pane`, or `herdr_agent` tools as a substitute.

Install the package required by the workflow you use:

```bash
# Required by ry-herdr-delegate
pi install npm:@andrewjacop/pi-herdr

# Optional companion tools for direct Herdr layout/pane/agent control
pi install npm:@ogulcancelik/pi-herdr

# Install this package
pi install npm:ry-skill
```

The two `pi-herdr` packages expose different tool surfaces and should not be treated as interchangeable. The Herdr packages do not include the standalone Herdr executable. Install Herdr separately and start Pi inside a Herdr-managed pane.

If you install or change either Pi package while a Pi session is already running, run `/reload` or restart Pi before using its tools. Confirm that the Herdr server is running before invoking `ry-herdr-delegate`; the skill does not start the standalone Herdr service.

## Skills and extensions

### ry-herdr-fork

Fork the current Pi session from a selected previous user message into a new
tab in the same Herdr workspace.

The flow matches Pi's built-in `/fork` semantics:

1. Show Pi's previous-user-message selector.
2. Copy the selected branch only through the entry immediately before that
   user message.
3. Open the copied history as an independent session in a new Herdr tab.
4. Put the selected user message in the new tab's editor without submitting it.
5. Keep the current tab, current session file, and current session leaf
   unchanged.

The new tab is created without taking focus. If Pi startup or editor restoration
fails, both the new tab and its fork session file are removed.

### ry-herdr-clone

Clone the current Pi session's active branch into a new tab in the same Herdr
workspace.

The flow matches Pi's built-in `/clone` semantics except that it does not
replace the session in the current tab:

1. Read the current active leaf.
2. Copy only the root-to-leaf active path into an independent session file.
3. Open that cloned session in a new Herdr tab with an empty editor.
4. Keep the current tab, source session file, and source leaf unchanged.

The new tab is created without taking focus. If startup fails, both the new tab
and its clone session file are removed.

### ry-herdr-delegate

Delegate a local reconnaissance, research, implementation, review, second-opinion, general task, or multi-stage workflow to a configured visible Herdr agent. The skill also activates automatically when a task asks Codex or Claude to perform work, even if the task does not name `ry-herdr-delegate`. It chooses one of six stage roles, or enters the separate `pipeline` orchestration mode, and calls `herdr_delegate` from `@andrewjacop/pi-herdr` with configurable `codex`, `claude`, or `pi` profiles. Pipeline mode analyzes the prompt and serially selects the smallest useful sequence of existing roles; it is not itself a role and can contain more than two stages. After a valid `DONE`, the default `panePolicy` is `new-tab`: the pane moves to a non-focused tab named `closed-pane-<communicationId>`, where `communicationId` is the communication Markdown filename without `.md`. The other policies are `keep` and `close`. Each response must include a recovery command only when the effective policy is `close`; the parent applies the final pane policy after validation.

The default role mapping is:

| Role | Agent |
| --- | --- |
| `scout` | `codex` |
| `researcher` | `claude` |
| `worker` | `codex` |
| `reviewer` | `claude` |
| `oracle` | `pi` |
| `delegate` | `pi` |

An actionable profile named in the task temporarily replaces only the matching role for that invocation. For example, `用 Claude 写代码` uses `claude` for `worker`, while an unqualified implementation request continues to use the configured `worker` profile. Activity-specific instructions can map different pipeline stages independently, such as Claude for implementation and Codex for review. The session-level default routes later actionable work through this skill but does not force reuse of a profile or child session. Comparative or historical mentions of Codex/Claude do not trigger delegation, and an explicit request not to delegate takes precedence.

After every `herdr_wait_agent` returns, the parent records an `AGENT SESSION` checkpoint before sending another prompt, starting another stage, or closing the pane. The checkpoint includes the pane status, pane id, agent kind/name, cwd, `agent_session.kind`, `agent_session.source`, and the complete `agent_session.value`. If `herdr_get_agent` omits `agent_session`, the parent uses `herdr_api_snapshot` to recover it; `herdr_session_list` is not a substitute because it identifies the Herdr server session, not the agent session.

Parent-child communication is persisted in one Markdown record per exact child session and transaction/stage scope under `./.pi/agent/ry-herdr-delegate/communications/`, resolved from the current project root. A single parent session may therefore have multiple records, including multiple records for one request when it has multiple pipeline stages or independent work items. The complete `agent_session` triple (`kind`, `source`, and `value`) identifies the child session; transaction and stage identity determine whether that session may be reused. Use a readable three-part filename such as `npm-worker-7f3a.md`; its basename without `.md` is the stable `communicationId` used for the post-success tab label `closed-pane-npm-worker-7f3a`. Record the parent and child session metadata in fixed-line frontmatter, append the complete task or follow-up before every delegation, and pass only the absolute record path plus the exact message line range and count in the child prompt. Pane id, agent name, role, agent kind, and cwd are lookup/context metadata. The child reads the indicated range and appends its `CHILD -> PARENT` result to the same record before emitting it.

Reuse the same record only for a continuation of the same transaction, same stage role/stage occurrence, and same exact child session. A pane id change after exact-session resume does not require a new record. Start a new child session and linked record for every independent transaction, new pipeline stage, changed role, changed concrete objective, or changed effective profile, even when the old and new stages use the same agent kind. In particular, `worker -> reviewer` always uses separate child sessions and separate records, including when both roles resolve to Codex; pass the worker result through the review record's parent message and `previousCommunication`/`previousSession` link. Frontmatter scalar fields such as `status`, `lastStatus`, `lastMessageId`, and `recoveryCount` are updated in place; never insert frontmatter keys after messages exist, because that would shift saved line ranges.

A direct request naming one of these Markdown records enters recovery mode for that record's original transaction and stage. The parent reads the complete append-only record, validates the latest status, line ranges, and exact child-session identity, checks the recorded project cwd and working tree, and appends a `recovery` message containing the new parent session before using Herdr. If the original pane is open and reports the same exact `agent_session`, it is reused; if the pane is definitively closed, the same exact session is resumed and the existing record is reused even if the replacement pane id changes. A pane with a different exact session must not receive the old record's relay; a new transaction or stage must receive a new linked record. The prompt sent to the child contains only the record path, message range, line count, message id, and fixed read/append instructions. Missing or uncertain pane/session metadata yields `BLOCKED` or `PARTIAL` rather than an implicit fresh session. A verified latest `DONE` state is reported as complete and is not rerun unless the user asks for a new change.

When a settled agent needs more work, the parent first classifies whether it is a continuation of the same transaction and stage. Only then does it verify that the complete `agent_session` triple exactly matches the record and reuse the pane with `herdr_send_prompt`; a different or unavailable identity is not treated as a match. A new transaction, pipeline stage, role, objective, or effective profile always starts a fresh child session and record, even if the same agent kind is selected. Only a definitive closed-pane result permits resuming the saved exact session for the same transaction and stage: Pi uses `--session <path>`, Codex uses `resume <id>`, and Claude uses `--resume <id>`. A transient lookup error is treated as unknown, not closed, and generic `--continue` or `resume --last` is never presented as exact continuity.

The default Codex profile passes `--yolo`. The default Claude profile passes `--dangerously-skip-permissions`. These flags enable autonomous execution by disabling normal approval, sandbox, or permission checks. Set the corresponding profile's `extraArgs` to `[]` in the global configuration to opt out. A permission prompt or agent question is not treated as completion: the skill keeps the Andrew Herdr pane open, waits for continuation, and only applies `close`, `keep`, or `new-tab` after a valid `DONE`.

Use [`ry-herdr-delegate/config.example.json`](ry-herdr-delegate/config.example.json) as the template for the optional global configuration at `~/.pi/agent/ry-herdr-delegate.json`; the skill does not create or overwrite that global file.

Use `/skill:ry-herdr-delegate` and describe the task, or include an explicit stage role such as `worker` or `reviewer`. To recover unfinished work from a saved communication record, name the file directly, for example `读取 ./.pi/agent/ry-herdr-delegate/communications/npm-worker-7f3a.md，恢复现场并继续未完成的工作`. Recovery reads the complete record, validates its latest state, checks the recorded pane and exact session, then reuses or resumes that session while appending the continuation to the same Markdown record. Use `/skill:ry-herdr-delegate pipeline` to force pipeline mode. A request such as `写代码+review` automatically enters pipeline mode. The planner can produce sequences such as `scout -> worker -> reviewer` or `researcher -> oracle -> worker -> reviewer`; `pipeline` is never passed to a child agent. The pipeline stops when a stage does not return a valid `DONE`, and reviewer stages only report findings unless a later worker stage is explicitly planned.

#### ry-herdr-delegate Architecture Summary

`ry-herdr-delegate` is a prompt-level orchestration protocol. It has no separate delegate runtime or hidden worker pool: the parent Pi session makes routing and completion decisions, `@andrewjacop/pi-herdr` supplies visible child panes through `herdr_delegate`, and project-local Markdown records carry the durable task and result history.

| Layer | Responsibility | Main invariant |
| --- | --- | --- |
| Parent Pi | Detect activation, select roles and profiles, plan pipelines, validate results, and apply pane policy | Transport state never counts as semantic completion |
| `herdr_delegate` | Start the configured Codex, Claude, or Pi child in a visible Herdr pane | Every stage starts through the exact `herdr_delegate` tool |
| Child agent | Read the recorded task, perform the assigned stage, and append its result | The child does not recursively delegate or close/move its own pane |
| Communication record | Persist parent messages, child results, checkpoints, and recovery history | One append-only record is scoped to one transaction/stage and exact child session |
| Pane disposition | Close, retain, or relocate a validated pane | Disposition happens only after a valid semantic `DONE` |

**Control flow.** The parent remains the orchestrator and the child remains the executor:

```text
User task
  -> activation precedence and role/profile resolution
  -> transaction and pipeline-stage planning
  -> create or reuse the scoped Markdown communication record
  -> append the complete parent handoff
  -> herdr_delegate(record path + exact line range only)
  -> visible Herdr pane runs the child agent
  -> child reads the record and appends its CHILD -> PARENT result
  -> parent waits, checkpoints the exact agent session, reads output, and validates
  -> continuation/recovery, next isolated stage, semantic result, or pane disposition
```

The protocol has two coordinated planes. The **control plane** is the parent Pi session, which owns activation, configuration resolution, stage planning, waiting, validation, recovery, and final pane actions. The **durable data plane** is the project-local Markdown record, which owns the authoritative task handoff, child result, checkpoints, linkage, and recovery history. Herdr provides visible process and pane transport between them; it is not the source of semantic completion.

**State model.** Herdr lifecycle values (`working`, `blocked`, `idle`, and `done`) describe transport state only. After every wait, the parent records the pane and exact `agent_session` checkpoint, then classifies the child contract as `DONE`, `BLOCKED`, `PARTIAL`, or `ERROR`. Only `DONE` with the required headings, validation evidence, and parent checkpoint may advance to the configured pane disposition or allow the next pipeline stage. A timeout, uncertain session lookup, malformed response, or disposition failure preserves the pane when possible and remains unresolved.

**Activation and routing.** Rules are evaluated in precedence order: explicit no-delegation or current-session execution, named-record recovery, explicit skill/direct delegation, actionable Codex or Claude instruction, then the session-local sticky default for later actionable work. Comparative, historical, quoted, and negative mentions do not activate the skill. Once activated, the sticky default does not force profile or session reuse; every independent task still receives a fresh child session and record.

Role selection and profile selection are separate. The six roles are `scout`, `researcher`, `worker`, `reviewer`, `oracle`, and `delegate`, with built-in mapping `scout -> codex`, `researcher -> claude`, `worker -> codex`, `reviewer -> claude`, `oracle -> pi`, and `delegate -> pi`. A prompt may temporarily override the profile for the matching activity, such as Claude for implementation or Codex for review, without changing global configuration. `pipeline` is parent-only orchestration: it plans sequential stages, creates a fresh child session and linked record for each stage, transfers prior results through recorded messages, and stops when a stage is not a valid `DONE`.

**Transaction and session isolation.** A child pane/session may be reused only when the transaction, concrete objective, stage role and occurrence, and complete exact `agent_session` triple (`kind`, `source`, `value`) are unchanged. A pane id, agent name, cwd, or matching agent kind is not enough. New transactions, stages, roles, objectives, or effective profiles always start new sessions and linked records. Therefore `worker -> reviewer` remains isolated even when both roles resolve to the same agent kind or profile. An exact closed-pane resume continues the same record; it does not turn into a new stage.

**Communication records.** Records live under `./.pi/agent/ry-herdr-delegate/communications/`, resolved from the current project root. Their three-part kebab-case filename is both a human-readable task key and the `communicationId`; for example, `npm-worker-7f3a.md` maps to `communicationId: npm-worker-7f3a`. Fixed-line YAML frontmatter stores both parent and child session metadata, `status`, `lastStatus`, `lastMessageId`, `recoveryCount`, stage data, and linkage to a prior record. Scalar fields are updated in place so previously relayed line ranges remain stable. Parent messages and child results are append-only, directional, serialized, and credential-free.

The child prompt is only a relay envelope containing the absolute record path, exact message line range, line count, and message id. The complete task, constraints, role contract, pipeline context, and completion contract are written to the record first. The child reads those lines and appends its complete `CHILD -> PARENT` result before emitting it. This makes the Markdown record the authoritative transcript; pane output is only a lifecycle/output fallback.

**Lifecycle and recovery.** `herdr_wait_agent` reports transport states such as `working`, `blocked`, `idle`, or `done`; these states are never completion by themselves. After every wait, including timeout or error, the parent records a checkpoint containing pane status, pane id, agent, cwd, workspace/tab context, and the raw exact session metadata. It obtains missing session data from `herdr_get_agent` or `herdr_api_snapshot`, and captures output with `herdr_read_agent` when possible. Semantic completion requires a valid child contract with `STATUS: DONE`, required headings, validation evidence, and the separate parent-owned checkpoint.

For same-stage follow-up, an open pane is reused only after its exact session matches the record. A definitively closed pane is resumed with exact arguments (`pi --session <path>`, `codex resume <id>`, or `claude --resume <id>`). Transient lookup failures remain `unknown`; missing identity, unsupported recovery, or unresolved questions produce `BLOCKED` or `PARTIAL`. Generic `--continue` and `resume --last` are fallback recovery commands, never proof of exact continuity.

**Completion and pane disposition.** The initial `herdr_delegate` call always uses `closeOnSuccess: false`, allowing the parent to validate the child and handle continuation before disposition. The configured `panePolicy` is `close`, `keep`, or `new-tab`, with `new-tab` as the default. After a valid `DONE`, `close` calls `herdr_close_pane`, `keep` leaves the pane in place, and `new-tab` creates a non-focused tab named `closed-pane-<communicationId>` in the source workspace, then moves the pane there with `herdr_move_pane`. The parent records the source and target tab metadata in a `pane-disposition` message. It does not use `newTab: true`, generate a random token, or derive the label from the session id. Incomplete results and disposition failures retain the pane when possible and return `BLOCKED`, `PARTIAL`, or `ERROR`.

**Configuration and boundaries.** Only `~/.pi/agent/ry-herdr-delegate.json` is read as user configuration; invalid or unknown fields are errors. Resolution is role override, selected profile, global defaults, then built-in defaults. Built-in Codex uses `--yolo`, Claude uses `--dangerously-skip-permissions`, and Pi uses no autonomy flag; generic `recoveryArgs` are fallback commands only. This skill depends on a running Herdr session and the exact `herdr_delegate` tool from `@andrewjacop/pi-herdr`. It does not substitute `@ogulcancelik/pi-herdr` layout tools, the standalone `herdr` CLI, manual agent startup, or in-process subagents. The separate `ry-herdr-fork` and `ry-herdr-clone` extensions intentionally use the standalone CLI for their own session-copy workflows.

### Zero-history invocation

Use the extension commands or their skill aliases:

```text
/herdr-fork
/skill:ry-herdr-fork
/herdr-clone
/skill:ry-herdr-clone
```

All four are handled before Pi appends a user message. Selecting, cancelling,
and success/error notifications use temporary TUI state only, so the current
session JSONL contains no command, skill invocation, tool call, fork marker, or
clone marker.

A natural-language request already submitted to the model is necessarily part
of the current conversation. Use one of the slash commands above when the
operation itself must leave no session history.

### Requirements

- Pi 0.83 or newer, running in interactive mode
- Herdr 0.8 or newer
- `herdr` and `pi` available in `PATH`
- `jq` available in `PATH` for the printed recovery command
- A persisted Pi session associated with the current pane
- For cloning, at least one entry on the current active branch

The source session must already contain an assistant response so Pi has written
its JSONL file. An unsaved first prompt cannot be opened by a second process.

## Development

Install peer dependencies, run the unit tests, verify the extension loads, and
inspect the package contents:

```bash
npm install
npm test
pi --extension ./ry-herdr-fork/index.ts \
  --extension ./ry-herdr-clone/index.ts \
  --list-models >/dev/null
npm pack --dry-run
```

## License

MIT
