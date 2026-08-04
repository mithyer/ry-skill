# ry-skill

Custom [Pi](https://pi.dev) skills for fast [Herdr](https://herdr.dev) workflows.

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

This package is designed to complement
[`@ogulcancelik/pi-herdr`](https://pi.dev/packages/@ogulcancelik/pi-herdr),
which gives Pi the structured `herdr_layout`, `herdr_pane`, and `herdr_agent`
tools. Installing both packages is recommended for complete Herdr support:

```bash
pi install npm:@ogulcancelik/pi-herdr
pi install npm:ry-skill
```

`ry-herdr-fork` intentionally invokes the standalone `herdr` CLI directly so
it can discover the current session, create the tab, and start the fork in one
script execution. Therefore `pi-herdr` is a companion package rather than an
npm runtime dependency. Declaring it as a normal dependency would not make Pi
load its extension and could register duplicate Herdr tools when users already
have it installed.

The `pi-herdr` package does not include the Herdr executable. Install Herdr
separately and start Pi inside a Herdr-managed pane.

## Skills

### ry-herdr-fork

Fork the current saved Pi session into a new tab in the same Herdr workspace.
The new tab keeps the current working directory, starts an independent Pi
session with `pi --fork`, and does not take focus. If startup fails, the newly
created tab is removed automatically.

Requirements:

- Pi 0.80 or newer, running inside a Herdr-managed pane
- Herdr 0.7.5 or newer
- `herdr`, `pi`, and `jq` available in `PATH`
- A saved Pi session associated with the current pane

Invoke it explicitly:

```text
/skill:ry-herdr-fork
```

It also loads automatically for requests such as:

```text
Fork the current Pi session into a new Herdr tab.
```

## Development

Validate the shell helper and npm package contents:

```bash
bash -n ry-herdr-fork/scripts/fork-current.sh
shellcheck ry-herdr-fork/scripts/fork-current.sh
npm pack --dry-run
```

## License

MIT
