---
name: ry-herdr-delegate
description: Rollback-only documentation for the legacy prompt-level Herdr delegate protocol. The active runtime is the project-owned ry_herdr_delegate_tool extension.
compatibility: Legacy rollback material only. The active package runtime uses the project-owned TypeScript extension and HerdrCliGateway.
---

# Legacy Delegate Rollback Material

This file documents the pre-TypeScript `ry-herdr-delegate` protocol only. It is
kept so the package history and whole-package rollback remain understandable;
it is not an active Pi skill in the current package. `package.json` registers
`ry-herdr-delegate/index.ts` as an extension and does not register this
folder under `pi.skills`.

## Active Runtime

Use the project-owned `ry_herdr_delegate_tool` extension for new work. Its
runtime boundaries are:

- `HerdrCliGateway` is the only delegate Herdr transport and uses Node
  `child_process.spawn` with `shell: false`, argv arrays, explicit `cwd` and
environment, cancellation/timeout, and captured output.
- JSONL/NDJSON event logs are the only authoritative communication and state
  format for the new runtime.
- `DelegateEngine` owns one leaf stage, exact session checkpoints, completion
  contract parsing, and semantic-DONE-gated pane disposition.
- `PipelineCoordinator` owns project/workspace-bound coordinator binding,
  durable inbox and pipeline logs, FIFO stage ticks, answer/stop controls, and
  exact closed-pane coordinator recovery.
- `pipeline.status` reads replay-derived state; it does not treat Herdr
  transport status as semantic completion.
- `recover` replays a pipeline JSONL log and routes continuation through the
  existing exact coordinator binding; it refuses a fresh replacement session
  when no binding exists.
- Codex, Claude, and other children do not need a communication-file plugin.
  The parent/coordinator owns JSONL validation and writes; children consume
  relay-designated events and return the fixed completion contract.
- The package does not call `@andrewjacop/pi-herdr` or
  `@ogulcancelik/pi-herdr` for delegate runtime behavior.

Supported structured actions are `delegate`, `pipeline`, `pipeline.status`,
`pipeline.answer`, `pipeline.stop`, `pipeline.coordinator`, and `recover`.
`recover` replays pipeline JSONL state through the existing exact coordinator
binding and refuses a fresh replacement session when no binding exists.

## Legacy Boundary

The former protocol used a parent prompt to select a role, call the external
`herdr_delegate` tool, write Markdown communication records, wait for a child,
and apply a pane policy. Those instructions are historical only. Do not use
them for new requests, and do not enable this folder as an active skill beside
the TypeScript extension. Running both paths would allow one request to have
two delegation owners.

Legacy Markdown communication records are not read, imported, converted, or
used for state recovery by the current runtime. New runtime records use
`.jsonl` and are stored below the project-local
`.pi/agent/ry-herdr-delegate/` directory.

## Rollback

A rollback is a whole-package rollback to a previously published `ry-skill`
version. It is not a migration path between Markdown and JSONL records:

1. Restore the old package version and reload Pi.
2. Re-enable the old external delegate dependencies only if that old package
   version requires them.
3. Treat old Markdown records as belonging to the old package version.
4. Preserve new JSONL logs, coordinator bindings, and pipeline files; do not
   ask the old runtime to interpret them.
5. Do not silently resume with `--last`, `--continue`, a fresh child, or a new
   coordinator when exact session continuity is required.

The old protocol's `agentArgs`, exact-session, pane-policy, and communication
record rules remain historical context for understanding prior records. They
do not override the TypeScript runtime contract.

## Current Validation Scope

The current implementation has automated coverage for configuration and argv
resolution, JSONL append/replay and idempotency, leaf completion and pane
policy, exact-session mismatch blocking, coordinator queue/tick behavior,
accepted acknowledgements, answer/stop control events, closed-pane exact
coordinator recovery, workspace isolation, path-safety checks, and coordinator
bootstrap races. Live smoke remains explicit validation work.
