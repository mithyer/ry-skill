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

Delegate a local reconnaissance, research, implementation, review, second-opinion, general task, or multi-stage workflow to a configured visible Herdr agent. The skill chooses one of six stage roles, or enters the separate `pipeline` orchestration mode, and calls `herdr_delegate` from `@andrewjacop/pi-herdr` with configurable `codex`, `claude`, or `pi` profiles. Pipeline mode analyzes the prompt and serially selects the smallest useful sequence of existing roles; it is not itself a role and can contain more than two stages. By default, each successful pane closes after its response is captured; each response must include a recovery command when the selected profile supports continuation.

The default role mapping is:

| Role | Agent |
| --- | --- |
| `scout` | `codex` |
| `researcher` | `claude` |
| `worker` | `codex` |
| `reviewer` | `claude` |
| `oracle` | `pi` |
| `delegate` | `pi` |

The default Codex profile passes `--dangerously-bypass-approvals-and-sandbox`, the current Codex CLI equivalent of `--yolo`; the default Claude profile passes `--dangerously-skip-permissions`. These flags enable autonomous execution by disabling normal approval, sandbox, or permission checks. Set the corresponding profile's `extraArgs` to `[]` in the global configuration to opt out. A permission prompt or agent question is not treated as completion: the skill keeps the Andrew Herdr pane open, waits for continuation, and only closes it after a valid `DONE`.

Use [`ry-herdr-delegate/config.example.json`](ry-herdr-delegate/config.example.json) as the template for the optional global configuration at `~/.pi/agent/ry-herdr-delegate.json`; the skill does not create or overwrite that global file.

Use `/skill:ry-herdr-delegate` and describe the task, or include an explicit stage role such as `worker` or `reviewer`. Use `/skill:ry-herdr-delegate pipeline` to force pipeline mode. A request such as `写代码+review` automatically enters pipeline mode. The planner can produce sequences such as `scout -> worker -> reviewer` or `researcher -> oracle -> worker -> reviewer`; `pipeline` is never passed to a child agent. The pipeline stops when a stage does not return a valid `DONE`, and reviewer stages only report findings unless a later worker stage is explicitly planned.

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
