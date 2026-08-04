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

## Skills

### ry-herdr-fork

Fork the current saved Pi session into a new tab in the same Herdr workspace.
The new tab keeps the current working directory, starts an independent Pi
session with `pi --fork`, and does not take focus. If startup fails, the newly
created tab is removed automatically.

Requirements:

- Pi running inside a Herdr-managed pane
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
