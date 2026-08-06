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

This package complements
[`@ogulcancelik/pi-herdr`](https://pi.dev/packages/@ogulcancelik/pi-herdr),
which gives Pi structured `herdr_layout`, `herdr_pane`, and `herdr_agent`
tools. Installing both packages is recommended for complete Herdr support:

```bash
pi install npm:@ogulcancelik/pi-herdr
pi install npm:ry-skill
```

The `ry-herdr-fork` and `ry-herdr-clone` extensions invoke the standalone
`herdr` CLI because they must create a tab and launch a second Pi process. The
`pi-herdr` package remains a companion rather than a runtime dependency;
declaring it as a normal dependency would not make Pi load its extension and
could register duplicate Herdr tools.

The `pi-herdr` package does not include the Herdr executable. Install Herdr
separately and start Pi inside a Herdr-managed pane.

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
