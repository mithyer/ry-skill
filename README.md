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

## Herdr Integration

This package has two deliberately separate Herdr integration paths:

- `ry-herdr-fork` and `ry-herdr-clone` use the standalone `herdr` CLI because they create tabs and launch independent Pi sessions.
- `ry-herdr-delegate` is the project-owned TypeScript extension. It registers `ry_herdr_delegate_tool`, persists JSONL event logs, and uses `HerdrCliGateway` with `node:child_process.spawn` and `shell: false`.

The delegate runtime does not call `@andrewjacop/pi-herdr` or `@ogulcancelik/pi-herdr`. Those packages expose different optional tool surfaces and are not runtime dependencies of this package. Install Herdr separately and start Pi inside a Herdr-managed pane. Restart Pi or run `/reload` after changing extensions.

The delegate extension requires Pi 0.83 or newer, Herdr 0.8 or newer, `pi` and `herdr` in `PATH`, and a TUI Pi process with `HERDR_WORKSPACE_ID` and `HERDR_PANE_ID`.

## Skills And Extensions

### ry-herdr-fork

Fork the current Pi session from a selected previous user message into a new,
non-focused tab in the same Herdr workspace. The source session, current tab,
and current active leaf remain unchanged. The copied history is opened with the
selected user message in the editor without submitting it. Startup failures
clean up the new tab and prepared session file.

### ry-herdr-clone

Clone the current Pi session's active branch into a new, non-focused tab in the
same Herdr workspace. The clone contains the active root-to-leaf path, opens
with an empty editor, and leaves the source tab and session unchanged. Startup
failures clean up the new tab and clone session file.

### ry-herdr-delegate

`ry-herdr-delegate` is implemented by the active project-owned
`ry_herdr_delegate_tool` extension. The old prompt-level Markdown protocol in
[`ry-herdr-delegate/SKILL.md`](ry-herdr-delegate/SKILL.md) is retained only as
rollback material and is not registered as an active Pi skill.

| Area | Runtime behavior |
| --- | --- |
| Leaf delegation | Creates a JSONL event log, resolves profile arguments, starts one child pane through `HerdrCliGateway`, waits, validates the completion contract, and applies `close`, `keep`, or `new-tab` only after semantic `DONE`. |
| Pipeline submission | Persists a complete request and FIFO inbox entry, then returns `QUEUED` or bounded-ack `ACCEPTED` without waiting for stage completion. |
| Coordinator | Uses one project/workspace-bound long-lived Pi pane, exact session binding, serial stage ticks, stage-specific JSONL logs, answer/stop controls, and closed-pane exact-session recovery. |
| Communication | JSONL/NDJSON is the sole runtime source of truth. Child agents read relay-designated events; the parent/coordinator owns validation and writes. No Codex/Claude communication plugin is required. |
| Herdr boundary | All delegate side effects pass through `HerdrCliGateway`, which uses argv arrays, explicit `cwd`/environment, cancellation/timeout, and captured stdout/stderr. |
| Recovery | Open-pane reuse and definitively closed-pane resume require the complete `agent_session` identity. Unknown or mismatched state returns `BLOCKED` or `PARTIAL`; generic latest-session fallback is not used. |

The structured tool supports these actions:

| Action | Meaning |
| --- | --- |
| `delegate` | Run one leaf stage. |
| `pipeline` | Persist a non-blocking pipeline request and ensure its coordinator. |
| `pipeline.status` | Read replay-derived pipeline and stage state. |
| `pipeline.answer` | Persist an answer for the first blocked stage and wake an eligible coordinator. |
| `pipeline.stop` | Persist an idempotent pipeline-level stop request without destroying the coordinator. |
| `pipeline.coordinator` | Run a coordinator tick only from the exact persisted coordinator pane/session. |
| `recover` | Replay a pipeline JSONL log and continue it only through an existing or exact-resumed coordinator. |

A pipeline submission is not a final result. Query `pipeline.status` with the
returned `pipelineId` until the persisted state reaches `DONE`, `BLOCKED`,
`PARTIAL`, `ERROR`, or `STOPPED`. The main Pi submits and queries; the
long-lived coordinator owns queueing, stage execution, checkpoints, recovery,
and aggregation.

The default role mapping is `scout -> codex`, `researcher -> claude`,
`worker -> codex`, `reviewer -> claude`, `oracle -> pi`, and `delegate -> pi`.
Invocation-local `agent`, `effort`, `extraArgs`, `cwd`, `timeoutMs`,
`panePolicy`, and explicit stage settings do not mutate global configuration.
Built-in Codex uses `--yolo`, Claude uses `--dangerously-skip-permissions`, and
Pi uses its normal arguments.

The default leaf pane policy is `new-tab`. After semantic `DONE`, the runtime
creates a non-focused tab named `closed-pane-<communicationId>` and moves the
completed child pane there. `close` and `keep` are explicit alternatives.
Incomplete outcomes preserve the pane when possible.

#### Debug Logging

Debug logging is disabled by default. Set `debug.level` in the optional global
configuration to `error`, `warn`, `info`, `debug`, or `trace`; `off` disables
all logger I/O. `debug.directory` defaults to
`.pi/agent/ry-herdr-delegate/debug` under the active project. The runtime
creates one append-only JSONL log per exact Pi session, named from the Pi
session JSONL basename. A later session with the same basename but a different
exact session identity receives `-2`, `-3`, and so on; calls from the same
identity always reuse its existing log. The first record contains the complete
session identity and runtime/version context.

`info` records request lifecycle, `debug` adds pipeline, pane, agent, and
session transitions, and `trace` adds command, lock, and JSONL I/O detail.
Every record automatically includes a top-level `callsite` object with source
file, method, line, and column. Callers do not supply that metadata; the
runtime captures the first non-debugger V8 stack frame. Credential-like values,
configured secret fields, and inline bearer/token forms are redacted before
writing.

Use [`ry-herdr-delegate/config.example.json`](ry-herdr-delegate/config.example.json)
as the template for the optional global configuration at
`~/.pi/agent/ry-herdr-delegate.json`. The extension never creates or overwrites
that file.

#### Structured Tool Examples

```json
{
  "action": "delegate",
  "task": "implement the requested change and run focused tests",
  "role": "worker",
  "panePolicy": "new-tab"
}
```

```json
{
  "action": "pipeline",
  "task": "implement and review the requested change",
  "stages": [
    { "role": "worker", "task": "implement the change" },
    { "role": "reviewer", "task": "review the implementation" }
  ]
}
```

The extension does not silently fall back to the old skill, an external
`herdr_delegate`, a fresh coordinator, or a latest-session recovery command.

#### Direct invocation and automatic routing

`/ry-herdr-delegate <task>` executes one leaf task through
`ry_herdr_delegate_tool` and reports its structured status. It is an execution
command, not a status-only command.

Before the model loop, the extension also detects an explicit actionable agent
directive such as `请使用 codex 修复这个问题`, `使用 Claude 审查这次修改`, or
`use Codex to implement this change`. It routes the original prompt directly to
the selected external agent with the `worker` profile and marks the input as
handled, so the model does not execute the same request a second time.

Incidental mentions such as `Codex 和 Claude 有什么区别？`, negative requests
such as `不要使用 codex`, slash commands, non-TUI input, and prompts received
while Pi is already busy are left to normal Pi handling.

### Zero-history Invocation

Use the extension commands or their skill aliases:

```text
/herdr-fork
/skill:ry-herdr-fork
/herdr-clone
/skill:ry-herdr-clone
```

These operations are handled before Pi appends a user message. Selecting,
cancelling, and success/error notifications use temporary TUI state only, so
the current session JSONL contains no command, skill invocation, tool call,
fork marker, or clone marker. A natural-language request already submitted to
the model is necessarily part of the current conversation.

## Development

Install dependencies, run type checking and tests, and inspect the package:

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The current fake/integration coverage includes JSONL replay, exact-session
identity, leaf pane policy, coordinator queue/tick behavior, accepted receipts,
answer/stop controls, closed-pane exact-session recovery, workspace isolation,
path-safety checks, and coordinator bootstrap races. Live smoke against an
authenticated Herdr workspace remains explicit validation work.

## License

MIT
