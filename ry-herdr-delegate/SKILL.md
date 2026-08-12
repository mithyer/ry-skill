---
name: ry-herdr-delegate
description: Delegates local reconnaissance, web research, implementation, review, second opinions, and general tasks to a configured visible Herdr agent through @andrewjacop/pi-herdr's herdr_delegate tool. Automatically activates for actionable requests to have Codex or Claude perform work, even when this skill is not named.
compatibility: Requires @andrewjacop/pi-herdr and a running Herdr session. This skill is intentionally separate from @ogulcancelik/pi-herdr's layout, pane, and agent tools.
---

# Delegate Through Herdr

Use this skill when a task should run in a separate, visible Herdr agent pane and the parent session should receive the result. This skill is a prompt-level orchestration protocol. It does not start agents through a shell, use the standalone `herdr` CLI, or reimplement delegation.

## Automatic Activation And Prompt Agent Overrides

When this skill is available in the current Pi session, inspect the user's task for an actionable request to have `codex` or `claude` perform work before choosing another delegation path. Such a request implicitly selects this skill and must call `herdr_delegate`, even when the user does not mention `ry-herdr-delegate` or use its slash command.

Once `ry-herdr-delegate` has actually been selected and its first delegation has started in the current parent Pi session, keep it as the session-level default for later actionable work tasks. This sticky default covers implementation, research, reconnaissance, review, documentation, and operational work even when a later task does not mention Codex, Claude, or this skill. It does not turn ordinary questions, status requests, or clarification into delegation, and it does not reuse an old child session for an unrelated task. Every independent task starts a new child session and communication record by default, even when it selects the same role, agent kind, or profile as an earlier task.

Apply these activation rules in order:

1. An explicit request not to delegate, not to use Herdr, to perform the work in the current session, or to use another explicitly named non-Herdr execution path wins for that task. Do not auto-activate or apply the sticky default to that task.
2. A request that names a communication Markdown record and asks to read, restore, resume, continue, or finish its unfinished work enters `recovery` mode. The named record is authoritative; do not infer a new role, task, or agent from the current prompt.
3. An explicit `/skill:ry-herdr-delegate` invocation or direct delegation request uses this skill and activates the session-level default after delegation starts.
4. An actionable `codex` or `claude` instruction uses this skill automatically. Examples include `用 Claude 写代码`, `让 codex 修复这个 bug`, and `use Claude to implement this feature`.
5. If the session-level default is already active, route a later actionable work task through this skill even when it contains no agent name. Infer the appropriate role or pipeline from the task and create a new child session and record for every independent task or pipeline stage; reuse an existing record only for a continuation of the same transaction, same stage role, and same exact child `agent_session`.
6. A background mention, comparison, quoted text, historical statement, or negative instruction does not activate the skill. For example, `比较 Codex 和 Claude`, `这个项目之前用过 Claude`, and `不要使用 Codex` are not delegation requests.

The automatic trigger is limited to actionable Codex and Claude instructions until the session-level default becomes active. After activation, the sticky default applies to actionable work requests generally, while the explicit higher-precedence exceptions above remain in force. The session-level default is state for the current parent Pi session only; it is not written to global configuration, does not survive into an unrelated parent session, and does not force one agent profile, role, pane, or child session for every later task.

Choose the stage role and the agent profile as separate decisions. First infer the role or pipeline from the requested activity, then apply any profile named for that activity. A prompt-level profile directive is temporary and overrides only the selected role's configured `agent` for the current invocation:

| User instruction | Stage role | Temporary profile |
| --- | --- | --- |
| `用 Claude 写代码` | `worker` | `claude` |
| `让 Codex 做 review` | `reviewer` | `codex` |
| `用 Claude 实现，再用 Codex review` | `worker` / `reviewer` | `claude` / `codex` |
| `用 Claude 完成整个任务` | every planned stage | `claude` |

Normalize case-insensitive `Codex` and `Codex CLI` to `codex`, and `Claude` and `Claude Code` to `claude`. Do not treat a profile name as a model name. In pipeline mode, bind a named profile to the nearest matching activity; apply it to every stage only when the prompt scopes it to the whole task. If two profiles are requested for the same activity without a clear order, ask the user instead of guessing. Never write a prompt-level override back to `~/.pi/agent/ry-herdr-delegate.json`.

## Required Tool Boundary

Call exactly `herdr_delegate` from `@andrewjacop/pi-herdr` for every delegation stage. A normal stage invocation has one stage; pipeline mode calls the same tool once per planned stage, sequentially. The same Andrew package's `herdr_wait_agent`, `herdr_read_agent`, and `herdr_send_prompt` are continuation helpers only after `herdr_delegate` returns a live question or non-terminal pane. Use its `herdr_close_pane`, `herdr_create_tab`, or `herdr_move_pane` only for post-validation pane disposition; none of these tools may replace the initial delegation call.

Do not substitute any of these for the delegation call:

- `herdr_layout`, `herdr_pane`, or `herdr_agent` from `@ogulcancelik/pi-herdr`;
- the standalone `herdr` CLI;
- `herdr_start_agent` plus manual prompt/wait calls;
- an in-process subagent facility.

Those tools and packages have different APIs and lifecycle semantics. If `herdr_delegate` is unavailable, stop and tell the user to install or reload `@andrewjacop/pi-herdr`; do not silently fall back to another implementation.

The spawned child must not call `herdr_delegate` again or spawn another agent unless the parent explicitly asks for recursive delegation.

## Transaction And Stage Isolation

Treat each independent user-requested work item as one transaction. A pipeline stage is also a separate child-session boundary, even when it belongs to the same parent request. Reuse a child pane/session and its communication record only when all of these remain the same:

- the transaction and concrete objective;
- the stage role and stage occurrence, such as `worker` stage 1 or `reviewer` stage 2; and
- the complete exact `agent_session` identity.

Start a new child session and a new communication record for a new transaction, a new pipeline stage, a changed stage role, or a changed effective agent/profile. This is mandatory even when the old and new stages use the same agent kind or profile. In particular, `worker -> reviewer` always uses separate child sessions and separate records, including when both roles resolve to Codex; the review receives the worker result through its own recorded parent message, never by continuing the worker session. Repeated occurrences of the same role in a pipeline are also separate sessions when their objectives differ.

A pane id, agent name, cwd, or matching agent kind is insufficient evidence for reuse. An exact session match is necessary but cannot override a transaction or stage boundary. Do not send a new transaction's relay to an old pane, do not resume an old exact session for a new role, and do not append a new transaction to an old record. Link related records with `previousCommunication` and `previousSession` when a later stage consumes an earlier result; the link transfers context, not session continuity.

The `Reuse A Settled Agent Session` procedure applies only to follow-up communication within the same transaction and stage. For a new transaction or stage, call `herdr_delegate` to create a fresh child session, even if an earlier pane is open or the same profile is selected.

## Shared Communication Records

The parent Pi and each child agent communicate through one durable Markdown record per exact child `agent_session`. This is mandatory for the initial task, every follow-up, blocked-question answer, resumed continuation, and child result. The prompt sent to Herdr carries only a file pointer and line range; task-specific message content must be written to the record before the tool call.

### Record identity and location

- Store records under the current project root at `./.pi/agent/ry-herdr-delegate/communications/`. Resolve this path against the current project directory and use the resulting absolute path when passing the record to a child.
- Create one record for exactly one child `agent_session` and one transaction/stage scope. A main Pi session may therefore have multiple records in this directory, including multiple records for one parent request when it has multiple pipeline stages. A pipeline stage normally has its own child session and record, even when adjacent stages use the same profile.
- Treat the complete `agent_session` triple (`kind`, `source`, and `value`) as the record identity. Pane id, agent name, stage role, agent kind, and cwd are lookup or context metadata, not session identity. A new pane may continue the same exact session; a reused pane that reports a different exact session must not receive the old record's messages.
- Use three readable kebab-case components for the filename: `<task>-<role>-<token>.md`, for example `npm-worker-7f3a.md` or `vpsresearch-reviewer-91c2.md`. The task component should identify the work; the role component should be the initial stage role; the token prevents collisions.
- Generate the token before the initial delegate call because the exact child session is known only after Herdr starts it. Begin with `childSession: pending`, then backfill the raw `agent_session` after `herdr_delegate` or `herdr_get_agent` exposes it. Do not rename the file after it has been passed to a child.
- Append every initial task, follow-up, blocked-question answer, recovery message, checkpoint, and child result to the same record while the same transaction, stage role, and exact child session remain active. A pane id change after an exact-session resume does not require a new record.
- Create and link a new record with `previousCommunication` and `previousSession` for every new transaction or pipeline stage that intentionally starts a new child session, including a stage that uses the same agent kind/profile as its predecessor. Do not create a new record merely because a pane closed, a pane id changed, or a follow-up is needed within the same transaction and stage. If the same pane reports a different exact session, treat that as a new session and apply this rule.
- Never put passwords, tokens, cookies, private keys, or other credentials in a communication record. The record is durable and may be read after the pane closes.

### Frontmatter and message records

Create every record with frontmatter that points in both directions:

```yaml
---
protocol: ry-herdr-delegate-communication/v1
communicationId: npm-worker-7f3a
stageRole: worker
panePolicy: new-tab
agentKind: codex
cwd: "/absolute/project/path"
parentSession:
  kind: path
  source: pi
  value: "/absolute/parent/session.jsonl"
recoveryCount: 0
childSession:
  kind: pending
  source: herdr
  value: pending
previousCommunication: null
previousSession: null
status: open
lastStatus: pending
lastMessageId: null
---
# Communication Record
```

`status` is the transport/record lifecycle (`open`, `closed`, or `unknown`); `lastStatus` is the latest semantic child result (`pending`, `DONE`, `BLOCKED`, `PARTIAL`, or `ERROR`). Update scalar values in place when a checkpoint or result changes them, and update `lastMessageId` to the newest appended message. An empty record starts with `recoveryCount: 0`. Keep the frontmatter's key set and line count fixed after creation: do not grow a YAML list or insert a new key because that would shift every stored message line range. Recovery history is represented by appended `recovery` messages containing the full parent session; increment `recoveryCount` in place without rewriting earlier messages.

Keep frontmatter and transcript updates append-safe with these invariants:

| Event | `status` | `lastStatus` |
| --- | --- | --- |
| Parent appends `task`, `continuation`, `recovery`, or `blocked-answer` | `open` unless the pane is known closed | `pending` |
| Child appends a valid result | `open` while the pane remains available, otherwise `closed` or `unknown` | the exact child `STATUS` |
| Parent appends a checkpoint | the checkpoint's `PANE STATUS` | unchanged unless the wait produced a timeout/tool error, then `PARTIAL` or `ERROR` |
| Definitive pane closure after a valid result | `closed` | retain the exact result status |
| Parent applies a successful `pane-disposition` | `closed` for `close`, `open` for `keep` or successful `new-tab` | retain `DONE` |
| Pane disposition fails or its result is uncertain | `unknown` when the pane cannot be inspected, otherwise `open` when retained | `PARTIAL` or `ERROR` |
| Pane lookup timeout or transient metadata failure | `unknown` | retain the last semantic status |

Always update `lastMessageId` after the append succeeds. Treat frontmatter as a fast index only; recovery must verify the newest transcript messages and matching checkpoint before deciding whether work is complete.

After the child session is known, replace only the `childSession` values with the raw `agent_session.kind`, `agent_session.source`, and complete `agent_session.value`; preserve the original parent session. Append messages rather than rewriting or summarizing earlier messages. Each message must identify direction, sender, recipient, timestamp, message kind, and both session references:

```markdown
## MESSAGE <message-id>
- Direction: PARENT -> CHILD
- Sender: pi
- Recipient: codex/worker
- Kind: task | continuation | recovery | blocked-answer | result | checkpoint | pane-disposition | error
- Timestamp: <ISO-8601 timestamp>
- Parent session: <kind/source/value>
- Child session: <kind/source/value or pending>
- Message lines: <start>-<end> (<count> lines)

### Content
<complete message body>
```

Use `CHILD -> PARENT` for child messages. A child result, question, or progress update must be appended to this file before it is emitted in the pane. The parent must read the record as the authoritative transcript after waiting; `herdr_read_agent` remains a lifecycle/output fallback, not a replacement for the record.

### Append and relay procedure

For every message sent to a child:

1. Read the current record and count its 1-indexed lines.
2. Append the complete message, including the task, stage objective, prior handoff, constraints, or continuation question. Calculate and write the exact new message range and count in the message header.
3. Only after the append succeeds, call `herdr_delegate` or `herdr_send_prompt` with a relay envelope containing the absolute record path and the exact range:

```text
COMMUNICATION FILE: /absolute/path/to/npm-worker-7f3a.md
MESSAGE LINES: 28-46
MESSAGE LINE COUNT: 19
MESSAGE ID: <message-id>

Read exactly these lines from the communication file before acting. The file is the authoritative task/context; do not rely on omitted prompt text. After producing a response, append your complete CHILD -> PARENT message to the same file before emitting the response. Preserve unrelated changes and do not recursively delegate.
```

4. If the append or the child read fails, return `BLOCKED` or `PARTIAL`; do not silently fall back to passing the full task directly in the prompt. A line range is a stable handoff reference, not an approximate line count. Serialize writes to the record: the parent is the only writer for `PARENT -> CHILD` messages, the child is the only writer for its `CHILD -> PARENT` messages, and no second message may be appended until the previous append and relay reference have been verified.

After every wait, append a `checkpoint` message containing the latest pane status and raw agent session metadata before deciding whether to continue or apply the final pane disposition. The checkpoint updates scalar frontmatter fields in place as well as the visible transcript. This makes the MD usable as a durable audit trail after the Herdr window is gone.


## Recover From A Communication Record

When the user directly names a communication Markdown record and asks to read it, restore the scene, resume, continue, or finish unfinished work, enter `recovery` mode. A path under `./.pi/agent/ry-herdr-delegate/communications/` is resolved from the current project root; an absolute path is accepted when it points to a record in the current project. Do not treat a bare filename as a new task until it has been resolved and verified.

Follow this recovery procedure before delegating or editing:

1. Read the complete MD, including YAML frontmatter and every appended message. Do not read only the tail: earlier task constraints, user decisions, prior handoffs, and links to replaced sessions are part of the context.
2. Validate the record protocol, `communicationId`, `cwd`, `stageRole`, parent/child session fields, message line ranges, and append-only ordering. Reject a missing file, malformed frontmatter, path outside the current project communication directory, or a record whose message ranges are inconsistent with its contents as `BLOCKED`; report the exact validation failure.
3. Determine the latest effective child state from the newest checkpoint and child message, giving explicit semantic completion precedence only when the latest child result is a valid `DONE` and a later or matching parent checkpoint records that result. A stale earlier `DONE` followed by a timeout, error, unresolved prompt, `BLOCKED`, or `PARTIAL` is unfinished work. A `working` state means wait on the existing pane before sending anything. An `idle` or `done` pane with no valid current `DONE` contract is resumable, not complete.
4. Verify the recorded `cwd` exists and matches the current project root unless the user explicitly names the recorded checkout. Inspect the current working tree and relevant changed files before continuing. Preserve unrelated changes and do not assume the filesystem still matches the old checkpoint.
5. Append a `PARENT -> CHILD` message of kind `recovery` to the same MD before any Herdr call. It must include the current parent session, the recovery request, the last recorded status, the intended continuation objective, and any new user instruction. Increment the fixed-line `recoveryCount` scalar in place; never overwrite the original `parentSession`, insert frontmatter keys, or rewrite an earlier recovery entry.
6. Check the recorded pane through `herdr_get_agent`. Compare the raw `agent_session.kind`, `agent_session.source`, and complete `agent_session.value` with the record's `childSession`; if the pane is open and the exact identity matches, reuse the same pane and record with `herdr_send_prompt`. If the pane is open but reports a different exact session, do not send it the old record's relay; treat it as a new child session and create a linked record only when a new session is intentionally allowed. If session metadata is temporarily unavailable, classify the identity as `unknown` rather than assuming a match. If it is `working`, use `herdr_wait_agent` and then follow the normal checkpoint procedure; do not submit a concurrent prompt. If it is `blocked`, resolve only a question answerable from the MD or the user's new instruction; otherwise return `BLOCKED` with the exact question.
7. If the pane is definitively closed, use the latest complete `agent_session` checkpoint in the MD. Resume the exact session through the same effective agent profile: Pi with `--session <path>`, Codex with `resume <id>`, or Claude with `--resume <id>`. Append those session-specific arguments only to the resumed delegation call. Do not use `resume --last`, `--continue`, a new profile, or a fresh session as an implicit substitute for exact recovery.
8. If the pane lookup is transiently unavailable, classify it as `unknown`, preserve the record, and return `PARTIAL` or `BLOCKED`; do not assume closure. If the record lacks a supported exact session kind/value, return `BLOCKED` and state that task context is recoverable but exact agent continuity is not.
9. Pass the absolute communication path, the exact newly appended message line range, the line count, and the recovery message id to the reused or resumed child. The child must read that range, inspect the complete record when needed, and append its complete `CHILD -> PARENT` result to the same MD before emitting it.
10. After every wait or resumed delegate return, append the parent-owned session checkpoint and follow the normal semantic completion loop. Update the fixed scalar fields `status`, `lastStatus`, `lastMessageId`, and `recoveryCount` in place using the record invariants above; never change the frontmatter line count. Preserve the same MD for an open or exact-resumed session within the same transaction and stage, even if the resumed pane id changes. If the next operation is a new transaction, a new pipeline stage, a changed role, or a changed effective profile, start a new child session and linked record instead of continuing this one; record the prior result and linkage before delegation. Never silently split the audit trail.

A recovery response to the user must include the record path, its last recognized semantic status, the project cwd used, whether the original pane was reused or the exact session resumed, the latest session checkpoint, and the next blocker or validation result. Do not claim completion merely because the MD was readable or a pane was opened. If the record's verified latest result is `DONE`, report that no unfinished work remains unless the user explicitly asks for a new change; do not rerun completed work by default.

## Select A Role Or Mode

Use an explicit stage role supplied after `/skill:ry-herdr-delegate` or in the task. Otherwise infer the most specific stage role from the task. A named Codex or Claude profile changes the agent used for that role; it does not change the role itself.

| Task signal | Stage role |
| --- | --- |
| Find files, trace entry points, map data flow, assess local risks | `scout` |
| Check websites or documentation and return sources | `researcher` |
| Implement a feature, fix a bug, or add tests | `worker` |
| Inspect a diff, regressions, tests, edge cases, and simplicity | `reviewer` |
| Challenge assumptions or compare options before acting | `oracle` |
| A self-contained request without a more specific role | `delegate` |

If a task explicitly combines multiple dependent activities, such as implementation plus review or research plus implementation, enter `pipeline` mode; this includes requests such as `写代码+review`. An explicit `pipeline` mode directive after `/skill:ry-herdr-delegate` forces pipeline mode, while an explicit stage role supplied there wins over automatic mode selection. `pipeline` is a mode directive, never a stage role or profile. Select `worker` for implementation alone and `reviewer` for review alone. If a task could equally be read as read-only analysis or implementation, ask which stage role is intended. Do not turn an ambiguous request into file edits.

## Interactive Wait And Completion

`herdr_delegate` and `herdr_wait_agent` report transport lifecycle, not semantic completion. Andrew's `agent prompt --wait` can return when the child reaches `blocked`, including a permission dialog or an agent question, and heterogeneous agents such as Claude or Codex may finish a turn as `idle` instead of `done`. A settled pane, successful tool return, `idle`, `done`, captured text, or permission/question prompt is therefore not sufficient by itself.

### Session Checkpoint After Every Wait

After every `herdr_wait_agent` invocation returns, including a timeout or error, create and output a session checkpoint before sending a follow-up, starting another stage, or closing the pane. `herdr_delegate` contains an internal wait that is not directly observable; after it returns, perform the same checkpoint before validating or closing its pane.

1. Call `herdr_get_agent(target)` and preserve the raw `agent_session`/`agentSession` object when the tool exposes it.
2. The current `@andrewjacop/pi-herdr` normalizer may omit that field from `herdr_get_agent`. When it is absent, call `herdr_api_snapshot` and match the agent by exact pane id, then name, then target; read `agent_session` from the matching raw agent entry. Do not use `herdr_session_list` for this: a Herdr server session is not an agent session.
3. Call `herdr_read_agent` as a best-effort capture of the output associated with this wait. If the pane has already disappeared, retain the last successful checkpoint and mark the pane as `closed` or `unknown` rather than silently dropping the session.
4. Output the following checkpoint in the parent response and stage handoff, using the complete session path or id without shortening it:

```text
AGENT SESSION:
- PANE STATUS: open | closed | unknown
- PANE: <pane id>
- AGENT: <kind/name>
- CWD: <working directory>
- SESSION KIND: <path | id | unavailable>
- SESSION SOURCE: <agent_session.source>
- SESSION VALUE: <agent_session.value>
- SESSION SEMANTICS: exact session | latest session in cwd | unavailable
```

The checkpoint is required even when the wait reached `working`, `blocked`, `idle`, or `done`; a lifecycle result is not a substitute for the session identity. Never apply the final pane disposition until this checkpoint and the final captured output have been recorded. If the raw session metadata cannot be obtained after an explicit lookup, output `unavailable` and state the lookup failure; never invent an id or path.

For every stage, preserve the pane while validating the response: invoke `herdr_delegate` with `closeOnSuccess: false` regardless of the effective `panePolicy`. Run this continuation loop with the remaining stage timeout and at most three automatic follow-ups. After each `herdr_wait_agent` call returns, complete the session checkpoint above before classifying the state, sending another prompt, or applying the final pane disposition:

1. Use `herdr_wait_agent` to observe the pane's current or next lifecycle state (`working`, `blocked`, `idle`, or `done`). This observation never completes the stage by itself.
2. Complete the parent-owned session checkpoint, then use `herdr_read_agent` output to determine whether the child returned a valid contract. Only a complete child contract with `STATUS: DONE`, all required child headings, validation evidence, and a separate parent `AGENT SESSION` checkpoint is semantic completion. A lifecycle `done` without that contract is incomplete; an `idle` state with that contract is a settled response for agents that do not emit `done`.
3. If the pane is `working`, wait for another state transition before sending a follow-up. If it is `blocked`, `idle`, or `done` without a valid DONE, classify the context. For a routine permission/question prompt that the original task and autonomy policy already answer, send a concise continuation with `herdr_send_prompt` to the same pane: tell the child to continue the current task, resolve routine prompts without stopping, preserve constraints, and end with the complete status contract. Do not start another agent or another pipeline stage.
4. If the context requires a user decision, a credential, an unsafe scope expansion, or an answer the parent cannot infer, stop the loop and return `BLOCKED` with the exact question, context, pane id, session checkpoint, and recovery information. Do not guess or blindly approve a permission dialog.
5. After sending a continuation, return to step 1. On timeout or after three unresolved follow-ups, keep the pane open when possible and return `PARTIAL` or `BLOCKED` with the latest session checkpoint rather than claiming completion.

After a valid `DONE` with required child headings, validation evidence, and a parent `AGENT SESSION` checkpoint, apply the effective `panePolicy`: `close` calls Andrew's `herdr_close_pane`, `keep` leaves the pane where it is, and `new-tab` uses the communication record's `communicationId` (the Markdown filename basename without `.md`) as the stable human-readable identifier. Create a new tab in the pane's current workspace with `herdr_create_tab` using the exact label `closed-pane-<communicationId>` and `focus: false`, then call `herdr_move_pane` with the created `tabId`. Do not generate a random token or derive the label from the exact agent session; the communication id is the durable navigation key, while the complete `agent_session` remains in the record for exact recovery. Do not use `newTab: true` for this disposition because it cannot guarantee the required tab name. Record the communication id, source workspace/tab, created tab id, and target label in the `pane-disposition` message. If a close, tab creation, or move operation fails, leave the pane open when possible and return `PARTIAL` or `ERROR` with the operation failure; do not claim the requested disposition succeeded. The built-in Codex and Claude autonomy flags should prevent ordinary permission prompts, but the validation loop remains mandatory when a prompt still appears or an agent asks for clarification.

## Reuse A Settled Agent Session

When a settled agent still has work to do within the same transaction and stage, reuse its existing session instead of starting a fresh task. This procedure never authorizes session reuse for a new transaction, pipeline stage, role, objective, or effective profile; those boundaries require a new child session and communication record even when the same agent kind is selected:

1. Check the pane first with `herdr_get_agent(target)`. If the normalized result lacks session metadata, use `herdr_api_snapshot` as described in the checkpoint procedure. A definitive `NOT_FOUND` or `PANE_GONE` result means the pane is closed; a timeout or transient tool error means `unknown`, not closed. An `idle` or `done` status means the transport is still open, but the pane is reusable only after its complete `agent_session` identity exactly matches the record's `childSession`.
2. If the pane is open and the exact identity matches, continue on the same target with `herdr_send_prompt`, then `herdr_wait_agent` and `herdr_read_agent`. If it is `working`, wait instead of submitting a concurrent prompt. If it is `blocked`, resolve the existing question before continuing. Preserve the same record; pane id, name, and status may change while the exact session remains the record identity. If the pane is open but its exact identity differs, do not send the old record's relay and do not append the new conversation to the old record.
3. If the pane is definitively closed, use the latest saved `agent_session` checkpoint to resume the exact session. This is a continuation of the same stage and the same communication record, not a new pipeline stage and not permission to create a fresh session. Invoke `herdr_delegate` with the same effective profile and role settings, `closeOnSuccess: false`, and append the exact resume arguments to the normal profile `agentArgs` only for this continuation:

| Effective agent | Session shape | Exact resume arguments |
| --- | --- | --- |
| `pi` | `kind: path` | `--session`, `<SESSION VALUE>` |
| `codex` | `kind: id` | `resume`, `<SESSION VALUE>` |
| `claude` | `kind: id` | `--resume`, `<SESSION VALUE>` |

Pass the original cwd and resolved environment as well. Send the continuation objective through the same record relay and require the full completion contract. The resumed pane may have a new pane id, but its exact session identity must remain the same; append the resumed communication to the existing record. If the CLI explicitly reports a different session value, stop and classify it as a new-session case instead of appending to the old record.
4. If the session kind/value is missing, unsupported, or the exact session cannot be resumed, return `BLOCKED` or `PARTIAL` with the saved checkpoint. Do not silently use `resume --last`, `--continue`, or a fresh agent; those are only acceptable when the user explicitly accepts `latest session in cwd` semantics. Never claim exact continuity when only a fallback session was opened.

For an exact closed-pane resume, append the generated session-specific resume arguments after the normal profile arguments. Do not send them on the initial `herdr_delegate` call, and do not replace them with the profile's generic `recoveryArgs`. Generic `recoveryArgs` remain a printed fallback command only.

## Role Contracts

Always include the current stage role contract in the recorded parent message for the child. The relay prompt must contain only the communication-file path, exact message range, line count, message id, and fixed read/append instructions. Pipeline orchestration itself has no child contract; it is applied by the parent, while each child receives its selected stage role contract through the recorded message.

- `scout`: Read-only local codebase reconnaissance. Report relevant files, entry points, data flow, risks, and unanswered questions. Do not edit, format, generate files, commit, or push.
- `researcher`: Research web or official documentation using available tools. Return concise conclusions with source URLs and distinguish verified facts from assumptions. Do not invent sources or edit the repository.
- `worker`: Implement the requested change in the current working directory, inspect existing patterns first, and run focused validation. Preserve unrelated user changes. Do not commit or push. If requirements, scope, or a destructive action is unclear, stop with `BLOCKED` and ask for a decision instead of guessing.
- `reviewer`: Review the requested code or plan first. Report findings before summary, ordered by severity and grounded in file paths and lines. Do not edit by default. Only make small fixes when the parent task explicitly authorizes reviewer edits and the fix is clearly within scope; validate authorized fixes and do not commit or push.
- `oracle`: Read-only second opinion before action. Challenge assumptions, identify missing constraints, compare alternatives, and recommend a path. Do not edit or run destructive operations.
- `delegate`: Behave like a lightweight version of the parent session. Complete the self-contained task within the stated scope, and report what was done, validated, or left unresolved.

## Pipeline Mode

`pipeline` is an orchestration mode, not a role, profile, or valid stage. The parent must plan one or more sequential stages from exactly these roles: `scout`, `researcher`, `oracle`, `worker`, `reviewer`, and `delegate`. The parent resolves every stage through the existing role/profile configuration and never creates a `pipeline` child. Each planned stage gets a fresh child session and communication record by default. A later stage may use the same agent kind or profile as an earlier stage, but it must not reuse that stage's pane, exact session, or record; prior results are transferred through the new stage's recorded parent message and linked `previousCommunication`/`previousSession` metadata. Stage roles may repeat only when each occurrence has a distinct objective stated in the plan. The pipeline must not recursively delegate, run stages concurrently, commit, or push.

For `scout`, `researcher`, and `oracle`, the read-only rule must be written into the recorded parent message even if the selected CLI has write-capable tools. Add CLI-specific read-only arguments in configuration when stronger enforcement is needed. In pipeline mode, stage roles own their permissions; a `reviewer` stage is read-only by default.

## Configuration

Read only this optional user configuration before selecting the profile:

```text
~/.pi/agent/ry-herdr-delegate.json
```

Do not search arbitrary files for configuration. If the file does not exist, use the built-in defaults below. If it exists but is invalid JSON, has an unsupported version, names an unknown role/profile, or selects an unsupported kind, stop and report the configuration error instead of silently changing agents.

The repository includes [`config.example.json`](config.example.json) as a configuration template; this skill does not create or overwrite the global configuration.

The supported profile kinds are exactly `codex`, `claude`, and `pi`. In this package, `claude` is both the user-facing profile name and the Herdr agent kind; do not translate it to `claude-code`.

The configuration shape is:

```json
{
  "version": 1,
  "defaults": {
    "timeoutMs": 180000,
    "panePolicy": "new-tab",
    "env": {}
  },
  "agents": {
    "codex": {
      "kind": "codex",
      "model": null,
      "effort": "high",
      "modelArgs": ["--model", "{model}"],
      "effortArgs": ["-c", "model_reasoning_effort=\"{effort}\""],
      "extraArgs": ["--yolo"],
      "recoveryArgs": ["resume", "--last"],
      "env": {}
    }
  },
  "roles": {
    "worker": {
      "agent": "codex",
      "effort": "high",
      "timeoutMs": 300000,
      "panePolicy": "new-tab",
      "extraArgs": [],
      "env": {}
    }
  },
  "pipelines": {
    "default": {
      "maxStages": 8
    }
  }
}
```

The built-in Codex profile passes `--yolo`. The built-in Claude profile passes `--dangerously-skip-permissions`. These flags disable normal approval, sandbox, or permission checks; set the selected profile's `extraArgs` to an empty array to opt out.

Validate the configuration before delegating:

- `version` must be `1`.
- `defaults.timeoutMs` and role/profile timeout overrides must be positive integers; `panePolicy` overrides must be exactly `close`, `keep`, or `new-tab`, with `new-tab` as the built-in default. For compatibility, a legacy boolean `closeOnSuccess` may be normalized only when `panePolicy` is absent at the same configuration layer (`true` becomes `close`, `false` becomes `keep`); if both fields are present at one layer, report a configuration error instead of guessing.
- Profile and role `model`, `effort`, and environment values must be strings when present; `null` means inherit for `model` or `effort`.
- `modelArgs`, `effortArgs`, `extraArgs`, and `recoveryArgs` must be arrays of strings. Environment maps must contain only string values. `recoveryArgs` is optional and is used only to construct a printed fallback recovery command; it is never sent to the initial `herdr_delegate` call. For an exact continuation after a pane closes, generate session-specific resume arguments from the saved `agent_session` (`pi`: `--session <path>`, `codex`: `resume <id>`, `claude`: `--resume <id>`) and send those arguments only to the resumed continuation call.
- `pipelines` is optional and may contain only the `default` process-policy entry. Its only field is `maxStages`, a positive integer no greater than `12`; it limits the number of dynamically selected stages and never selects roles or agent settings. The built-in default is `8` stages. Stage names are selected from `scout`, `researcher`, `oracle`, `worker`, `reviewer`, and `delegate`; `pipeline` is never a valid stage. Unknown pipeline fields or stage roles are errors.
- Profile `kind` must be exactly `codex`, `claude`, or `pi`. Unknown roles, profiles, kinds, or configuration keys are errors; stop instead of silently accepting typos.
- `effort` values are passed through the profile's argument template; the selected CLI remains responsible for accepting or rejecting a particular value.

Resolve `panePolicy` from the role override, then the global default, then the built-in `new-tab` default. Normalize a legacy `closeOnSuccess` value at the same configuration layer only when `panePolicy` is absent. A missing role field or a `null` role value inherits from the profile for profile-owned fields and from global defaults for `panePolicy`. Merge environment maps in the same order, with later values overriding earlier keys. `modelArgs` and `effortArgs` come from the selected profile; role overrides may change the model or effort value but not the profile's argument templates. A role-level `recoveryArgs` replaces the profile value. In pipeline mode, resolve the process policy first, then select each stage from the six allowed stage roles and resolve it through the normal role/profile rules; the pipeline never supplies agent settings itself.

When the prompt names an agent for an activity, treat that name as an invocation-local replacement for the selected role's `agent` reference before applying the normal role/profile resolution. Use the named configured profile when present, falling back to the built-in profile defaults when it is absent, and keep the role's timeout, pane policy, extra arguments, environment overrides, and other role-level settings. The global configuration remains unchanged. For example, `用 Claude 写代码` resolves the `worker` role through the `claude` profile for this invocation; a worker role configured with `codex` returns to `codex` on the next task that does not name an agent.

Build `agentArgs` as follows:

1. If an effective `model` is set, expand `{model}` in the profile's `modelArgs`.
2. If an effective `effort` is set, expand `{effort}` in the profile's `effortArgs`.
3. Append profile `extraArgs`, then role `extraArgs`.
4. Pass the resulting array literally as `herdr_delegate.agentArgs`; never join it into a shell command.
5. Only for a closed-pane exact-session continuation, append the generated session-specific resume arguments after the normal profile arguments. Never append them to the initial delegation call.

Pass the resolved environment map as `herdr_delegate.env`; never interpolate environment values into `agentArgs`. A missing `model` means the selected CLI uses its own model default. `modelArgs` and `effortArgs` are skipped when their corresponding value is unset. Do not put API keys, tokens, cookies, or other credentials in this file.

Built-in role-to-profile defaults are used for omitted role entries; an explicit global role override wins. When no global configuration exists, the complete built-in mapping is used:

| Role | Profile |
| --- | --- |
| `scout` | `codex` |
| `researcher` | `claude` |
| `worker` | `codex` |
| `reviewer` | `claude` |
| `oracle` | `pi` |
| `delegate` | `pi` |

When a profile or role field is absent, built-in profile defaults use `panePolicy: new-tab`, Codex's `--yolo`, Claude's `--dangerously-skip-permissions`, and these recovery arguments: Codex uses `resume --last`, Claude uses `--continue`, and Pi uses `--continue`. These recover the most recent saved session in the current directory when the CLI supports it; they are not guarantees of exact session identity. The autonomy flags disable normal approval, sandbox, or permission checks and can be removed with a profile `extraArgs: []` override. When no `pipelines.default.maxStages` is configured, the built-in pipeline limit is `8`; it does not define a role sequence.

## Build The Child Prompt

Make each child prompt a relay envelope rather than a second copy of the task. Before constructing it, append one complete parent message to the communication record and calculate its exact 1-indexed line range. That recorded message must contain the current working directory, current stage role, effective agent kind, effective `recoveryArgs`, exact user task, relevant constraints, and, in pipeline mode, the generated plan, stage index, total stages, stage objective, preceding stage result, role contract, and completion contract. The child must read the indicated record lines before acting; the record is the authoritative task/context source. Do not pass task-specific content, role instructions, or completion headings outside the recorded range. Re-read the file after the append and verify that the recorded range still contains the complete message before calling Herdr. The child must append its complete `CHILD -> PARENT` result to the same record before emitting the response.

Include only this fixed relay envelope in every initial, continuation, blocked-answer, and resumed prompt:

```text
COMMUNICATION FILE: <absolute path>
MESSAGE LINES: <start>-<end>
MESSAGE LINE COUNT: <count>
MESSAGE ID: <message-id>

Read exactly the indicated lines before acting. The communication record is the authoritative task and context. Do not rely on omitted prompt text or invent missing context. Append your complete CHILD -> PARENT result to the same record before emitting it. The path and line range are the only task handoff; fixed protocol metadata in this envelope is not a substitute for the recorded message.
```

Include the following completion contract in the recorded parent message; do not copy this block into the relay prompt:

```text
STATUS: DONE | BLOCKED | PARTIAL
PIPELINE STAGE: (required in pipeline mode; N/A otherwise)
SUMMARY:
CHANGED FILES:
VALIDATION:
RISKS / OPEN DECISIONS:
SOURCES: (required for researcher; N/A otherwise)
AGENT SESSION: (parent-owned checkpoint appended after each `herdr_wait_agent`; the child must not invent or guess this value)
RECOVERY COMMAND: (required when the effective `panePolicy` is `close`; N/A for `keep` or `new-tab`)
RECOVERY SEMANTICS: (exact session, latest session in cwd, fresh agent, or unavailable)
```

Include the completion contract in the recorded parent message. The relay prompt contains only the fixed envelope above. The child must put this contract at the end of its response and keep it concise enough to remain in the captured result tail. A valid child completion has exactly one `STATUS` line using one of the three allowed values and all required child headings; a researcher must also provide `SOURCES` with URLs. The parent appends the `AGENT SESSION` checkpoint after each wait and must not accept a child-invented or guessed session value as evidence. A reviewer may return `DONE` with findings; findings are the review result and do not trigger an automatic repair loop. When the effective `panePolicy` is `close`, the child must print a shell-quoted recovery command after the result, using the effective agent kind, current working directory, and `recoveryArgs`; for `keep` or `new-tab`, it may report `N/A` because the pane remains available after disposition. The parent, not the child, applies the final pane policy and writes the `pane-disposition` message. The child must not close or move its own pane. The command should create a sibling pane and start the agent there; use `jq` to extract the pane ID from Herdr's JSON response. Label whether the command resumes the exact session, the latest session in the current directory, or only starts a fresh agent. Never include credentials or secret environment values. Tell the child that it is operating in a visible delegated pane, must not recursively delegate, must not commit or push, and must preserve unrelated working-tree changes. For implementation work, explicitly say whether edits are expected. For research, require URLs and mark unverified claims. For review work, explicitly say that the task is read-only unless the parent has authorized reviewer edits.

Use this shell shape for a recovery command, replacing `<kind>`, `<recovery-args>`, and the shell-quoted working directory with effective values:

```sh
pane_id="$(herdr pane split --current --direction right --cwd '<cwd>' --no-focus | jq -r '.result.pane.pane_id')" && \
herdr agent start "ry-herdr-recover-<kind>-$(date +%s)" --kind <kind> --pane "$pane_id" -- <recovery-args>
```

For example, a Codex profile with `recoveryArgs: ["resume", "--last"]` resumes the most recent saved Codex session in that directory, not necessarily the exact delegated session. Do not claim exact restoration unless the CLI exposes and the command includes the exact session identifier.

## Plan Pipeline Mode

Before the first delegate call in pipeline mode, generate a concise ordered plan from the original request and current working directory. Each planned stage must contain:

- a unique stage number and one allowed stage role (`scout`, `researcher`, `oracle`, `worker`, `reviewer`, or `delegate`);
- a concrete objective for that stage;
- the inputs it may use, including relevant prior stage results;
- the expected output or handoff for the next stage.

Choose the smallest sequence that satisfies the request and preserve dependencies:

- use `scout` before implementation or review when local structure or entry points are not already clear;
- use `researcher` before implementation when external facts or documentation are required;
- use `oracle` before action when the task explicitly needs assumption-challenging or option comparison;
- use `worker` for repository changes;
- use `reviewer` after changes when the request asks for review;
- use `delegate` only for a self-contained stage without a more specific role.

A plan may contain more than two stages and may repeat a stage role only when each occurrence has a distinct objective. For example, an explicit request to review and then fix findings may use `worker -> reviewer -> worker -> reviewer`; the reviewer never edits. Do not add stages merely because they are available, do not place `pipeline` in the plan, and do not silently truncate a plan that exceeds `maxStages`; report the limit as `BLOCKED` and ask for a smaller scope. Record the plan in the parent result and pass the relevant prior result to each next stage.

## Call `herdr_delegate`

For a non-pipeline role, resolve one effective profile, including any prompt-level agent override, and make one `herdr_delegate` call with:

- `agent`: the profile's `kind` (`codex`, `claude`, or `pi`);
- `agentArgs`: the expanded literal argument array;
- `prompt`: only the fixed communication-file relay envelope; all task-specific content, role instructions, constraints, plan data, and completion contract must already be in the recorded parent message;
- `cwd`: the current project directory, unless the user explicitly names another checkout;
- `timeoutMs`: the role override, profile/default timeout, or `180000`;
- `closeOnSuccess`: always pass `false` to the initial `herdr_delegate` call so semantic validation and interactive continuation can finish before pane closure; retain the effective role/default value as the post-validation close policy;
- `env`: the resolved environment map, when non-empty.

For pipeline mode, first build the ordered plan above, then resolve each stage's existing role/profile configuration plus any activity-scoped prompt override. Write the plan, stage objective, and previous stage's concise result into that stage's parent message and make the same `herdr_delegate` call once per stage, including the continuation wait when the stage is blocked or interactive, before starting the next. Use the same `cwd` for every stage and pass only the relay envelope to the child. Do not run stages concurrently. Start each next stage only after the previous stage returns a valid `DONE`; otherwise stop and preserve the incomplete result and recovery command. A later `worker` may act on a prior `reviewer` result only when that stage is explicitly present in the plan.

Do not run multiple workers against the same working tree concurrently. Read-only scouts, researchers, and oracles may be parallelized only when the user requests it and each prompt is independent. `herdr_delegate` has no automatic worktree isolation; use an explicitly prepared checkout when isolated edits are required.

## Handle The Result

- For a non-pipeline role, treat one valid `DONE` result as completion.
- For pipeline mode, every planned stage must return a valid `DONE`; a reviewer `DONE` with findings is still a completed stage because findings are handed to any explicitly planned later stage and are not an automatic repair loop. Preserve the plan, every stage's status, changed files, validation, review findings, recovery command/semantics, session checkpoint, and blockers.
- Treat a missing or malformed status line, a timeout, a tool error, output that only shows pane startup, or any non-terminal lifecycle state without a valid contract as incomplete. A successful `herdr_delegate` call or a settled pane is not semantic completion. Preserve the parent-owned session checkpoint even when the child response is incomplete.
- Treat `BLOCKED` and `PARTIAL` as incomplete and surface the blocker or missing work. Claim completion only for a valid `DONE` response with all required headings and validation evidence.
- For `worker` or an explicitly authorized reviewer that edited files, inspect the resulting diff and run the parent-level validation before claiming completion.
- Before any follow-up work after a settled wait, first classify whether it is a continuation of the same transaction and stage. Apply `Reuse A Settled Agent Session` only in that case; a new transaction, pipeline stage, role, objective, or effective profile must call `herdr_delegate` for a fresh child session and record.
- With the effective `closeOnSuccess: true`, preserve and print every child's recovery command after the response, but apply closure only after a valid `DONE` by calling Andrew's `herdr_close_pane`. Leave the pane open for `BLOCKED`, `PARTIAL`, timeout, malformed output, or an unresolved interactive prompt. Pane retention does not replace response validation.
- Do not report a task as complete solely because a pane started or reached `idle`/`blocked`/`done`; completion requires the continuation loop to obtain a valid semantic `DONE` result and appropriate validation.
