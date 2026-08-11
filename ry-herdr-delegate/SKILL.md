---
name: ry-herdr-delegate
description: Delegates local reconnaissance, web research, implementation, review, second opinions, and general tasks to a configured visible Herdr agent through @andrewjacop/pi-herdr's herdr_delegate tool.
compatibility: Requires @andrewjacop/pi-herdr and a running Herdr session. This skill is intentionally separate from @ogulcancelik/pi-herdr's layout, pane, and agent tools.
---

# Delegate Through Herdr

Use this skill when a task should run in a separate, visible Herdr agent pane and the parent session should receive the result. This skill is a prompt-level orchestration protocol. It does not start agents through a shell, use the standalone `herdr` CLI, or reimplement delegation.

## Required Tool Boundary

Call exactly `herdr_delegate` from `@andrewjacop/pi-herdr` for every delegation stage. A normal stage invocation has one stage; pipeline mode calls the same tool once per planned stage, sequentially.

Do not substitute any of these for the delegation call:

- `herdr_layout`, `herdr_pane`, or `herdr_agent` from `@ogulcancelik/pi-herdr`;
- the standalone `herdr` CLI;
- `herdr_start_agent` plus manual prompt/wait calls;
- an in-process subagent facility.

Those tools and packages have different APIs and lifecycle semantics. If `herdr_delegate` is unavailable, stop and tell the user to install or reload `@andrewjacop/pi-herdr`; do not silently fall back to another implementation.

The spawned child must not call `herdr_delegate` again or spawn another agent unless the parent explicitly asks for recursive delegation.

## Select A Role Or Mode

Use an explicit stage role supplied after `/skill:ry-herdr-delegate` or in the task. Otherwise infer the most specific stage role from the task:

| Task signal | Stage role |
| --- | --- |
| Find files, trace entry points, map data flow, assess local risks | `scout` |
| Check websites or documentation and return sources | `researcher` |
| Implement a feature, fix a bug, or add tests | `worker` |
| Inspect a diff, regressions, tests, edge cases, and simplicity | `reviewer` |
| Challenge assumptions or compare options before acting | `oracle` |
| A self-contained request without a more specific role | `delegate` |

If a task explicitly combines multiple dependent activities, such as implementation plus review or research plus implementation, enter `pipeline` mode; this includes requests such as `写代码+review`. An explicit `pipeline` mode directive after `/skill:ry-herdr-delegate` forces pipeline mode, while an explicit stage role supplied there wins over automatic mode selection. `pipeline` is a mode directive, never a stage role or profile. Select `worker` for implementation alone and `reviewer` for review alone. If a task could equally be read as read-only analysis or implementation, ask which stage role is intended. Do not turn an ambiguous request into file edits.

## Role Contracts

Always include the current stage role contract in each child prompt. Pipeline orchestration itself has no child contract; it is applied by the parent, while each child receives only its selected stage role contract.

- `scout`: Read-only local codebase reconnaissance. Report relevant files, entry points, data flow, risks, and unanswered questions. Do not edit, format, generate files, commit, or push.
- `researcher`: Research web or official documentation using available tools. Return concise conclusions with source URLs and distinguish verified facts from assumptions. Do not invent sources or edit the repository.
- `worker`: Implement the requested change in the current working directory, inspect existing patterns first, and run focused validation. Preserve unrelated user changes. Do not commit or push. If requirements, scope, or a destructive action is unclear, stop with `BLOCKED` and ask for a decision instead of guessing.
- `reviewer`: Review the requested code or plan first. Report findings before summary, ordered by severity and grounded in file paths and lines. Do not edit by default. Only make small fixes when the parent task explicitly authorizes reviewer edits and the fix is clearly within scope; validate authorized fixes and do not commit or push.
- `oracle`: Read-only second opinion before action. Challenge assumptions, identify missing constraints, compare alternatives, and recommend a path. Do not edit or run destructive operations.
- `delegate`: Behave like a lightweight version of the parent session. Complete the self-contained task within the stated scope, and report what was done, validated, or left unresolved.

## Pipeline Mode

`pipeline` is an orchestration mode, not a role, profile, or valid stage. The parent must plan one or more sequential stages from exactly these roles: `scout`, `researcher`, `oracle`, `worker`, `reviewer`, and `delegate`. The parent resolves every stage through the existing role/profile configuration and never creates a `pipeline` child. Stage roles may repeat only when each occurrence has a distinct objective stated in the plan. The pipeline must not recursively delegate, run stages concurrently, commit, or push.

For `scout`, `researcher`, and `oracle`, the prompt-level read-only rule is mandatory even if the selected CLI has write-capable tools. Add CLI-specific read-only arguments in configuration when stronger enforcement is needed. In pipeline mode, stage roles own their permissions; a `reviewer` stage is read-only by default.

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
    "closeOnSuccess": true,
    "env": {}
  },
  "agents": {
    "codex": {
      "kind": "codex",
      "model": null,
      "effort": "high",
      "modelArgs": ["--model", "{model}"],
      "effortArgs": ["-c", "model_reasoning_effort=\"{effort}\""],
      "extraArgs": [],
      "recoveryArgs": ["resume", "--last"],
      "env": {}
    }
  },
  "roles": {
    "worker": {
      "agent": "codex",
      "effort": "high",
      "timeoutMs": 300000,
      "closeOnSuccess": true,
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

Validate the configuration before delegating:

- `version` must be `1`.
- `defaults.timeoutMs` and role/profile timeout overrides must be positive integers; `closeOnSuccess` must be boolean.
- Profile and role `model`, `effort`, and environment values must be strings when present; `null` means inherit for `model` or `effort`.
- `modelArgs`, `effortArgs`, `extraArgs`, and `recoveryArgs` must be arrays of strings. Environment maps must contain only string values. `recoveryArgs` is optional and is used only to construct a printed recovery command; it is never sent to the initial `herdr_delegate` call.
- `pipelines` is optional and may contain only the `default` process-policy entry. Its only field is `maxStages`, a positive integer no greater than `12`; it limits the number of dynamically selected stages and never selects roles or agent settings. The built-in default is `8` stages. Stage names are selected from `scout`, `researcher`, `oracle`, `worker`, `reviewer`, and `delegate`; `pipeline` is never a valid stage. Unknown pipeline fields or stage roles are errors.
- Profile `kind` must be exactly `codex`, `claude`, or `pi`. Unknown roles, profiles, kinds, or configuration keys are errors; stop instead of silently accepting typos.
- `effort` values are passed through the profile's argument template; the selected CLI remains responsible for accepting or rejecting a particular value.

Resolve scalar values in this order: role override, referenced agent profile, global defaults, then the built-in default. A missing role field or a `null` role value inherits from the profile. Merge environment maps in the same order, with later values overriding earlier keys. `modelArgs` and `effortArgs` come from the selected profile; role overrides may change the model or effort value but not the profile's argument templates. A role-level `recoveryArgs` replaces the profile value. In pipeline mode, resolve the process policy first, then select each stage from the six allowed stage roles and resolve it through the normal role/profile rules; the pipeline never supplies agent settings itself.

Build `agentArgs` as follows:

1. If an effective `model` is set, expand `{model}` in the profile's `modelArgs`.
2. If an effective `effort` is set, expand `{effort}` in the profile's `effortArgs`.
3. Append profile `extraArgs`, then role `extraArgs`.
4. Pass the resulting array literally as `herdr_delegate.agentArgs`; never join it into a shell command.

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

When a profile or role field is absent, built-in profile defaults use `closeOnSuccess: true` and these recovery arguments: Codex uses `resume --last`, Claude uses `--continue`, and Pi uses `--continue`. These recover the most recent saved session in the current directory when the CLI supports it; they are not guarantees of exact session identity. When no `pipelines.default.maxStages` is configured, the built-in pipeline limit is `8`; it does not define a role sequence.

## Build The Child Prompt

Make each child prompt self-contained. Include the current working directory, the current stage role, the effective agent kind, the effective `recoveryArgs`, the exact user task, relevant constraints, and, in pipeline mode, the generated plan, stage index, total stages, stage objective, and preceding stage's concise result. Tell the reviewer that the current working tree is the implementation under review and that it must report findings without editing. Include this completion contract:

```text
STATUS: DONE | BLOCKED | PARTIAL
PIPELINE STAGE: (required in pipeline mode; N/A otherwise)
SUMMARY:
CHANGED FILES:
VALIDATION:
RISKS / OPEN DECISIONS:
SOURCES: (required for researcher; N/A otherwise)
RECOVERY COMMAND: (required when closeOnSuccess is true; N/A only when no safe continuation exists)
RECOVERY SEMANTICS: (exact session, latest session in cwd, fresh agent, or unavailable)
```

The child must put this contract at the end of its response and keep it concise enough to remain in the captured result tail. A valid completion has exactly one `STATUS` line using one of the three allowed values and all required headings; a researcher must also provide `SOURCES` with URLs. A reviewer may return `DONE` with findings; findings are the review result and do not trigger an automatic repair loop. When `closeOnSuccess` is true, the child must print a shell-quoted recovery command after the result, using the effective agent kind, current working directory, and `recoveryArgs`. The command should create a sibling pane and start the agent there; use `jq` to extract the pane ID from Herdr's JSON response. Label whether the command resumes the exact session, the latest session in the current directory, or only starts a fresh agent. Never include credentials or secret environment values. Tell the child that it is operating in a visible delegated pane, must not recursively delegate, must not commit or push, and must preserve unrelated working-tree changes. For implementation work, explicitly say whether edits are expected. For research, require URLs and mark unverified claims. For review work, explicitly say that the task is read-only unless the parent has authorized reviewer edits.

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

For a non-pipeline role, resolve one profile and make one `herdr_delegate` call with:

- `agent`: the profile's `kind` (`codex`, `claude`, or `pi`);
- `agentArgs`: the expanded literal argument array;
- `prompt`: the complete child prompt;
- `cwd`: the current project directory, unless the user explicitly names another checkout;
- `timeoutMs`: the role override, profile/default timeout, or `180000`;
- `closeOnSuccess`: the role/default value, or `true`;
- `env`: the resolved environment map, when non-empty.

For pipeline mode, first build the ordered plan above, then resolve each stage's existing role/profile configuration and make the same `herdr_delegate` call once per stage, waiting for each result before starting the next. Use the same `cwd` for every stage and pass the plan, stage objective, and previous stage's concise result into the next prompt. Do not run stages concurrently. Start each next stage only after the previous stage returns a valid `DONE`; otherwise stop and preserve the incomplete result and recovery command. A later `worker` may act on a prior `reviewer` result only when that stage is explicitly present in the plan.

Do not run multiple workers against the same working tree concurrently. Read-only scouts, researchers, and oracles may be parallelized only when the user requests it and each prompt is independent. `herdr_delegate` has no automatic worktree isolation; use an explicitly prepared checkout when isolated edits are required.

## Handle The Result

- For a non-pipeline role, treat one valid `DONE` result as completion.
- For pipeline mode, every planned stage must return a valid `DONE`; a reviewer `DONE` with findings is still a completed stage because findings are handed to any explicitly planned later stage and are not an automatic repair loop. Preserve the plan, every stage's status, changed files, validation, review findings, recovery command/semantics, and blockers.
- Treat a missing or malformed status line, a timeout, a tool error, or output that only shows pane startup as incomplete. A successful `herdr_delegate` call or a settled pane is not semantic completion.
- Treat `BLOCKED` and `PARTIAL` as incomplete and surface the blocker or missing work. Claim completion only for a valid `DONE` response with all required headings and validation evidence.
- For `worker` or an explicitly authorized reviewer that edited files, inspect the resulting diff and run the parent-level validation before claiming completion.
- With the default `closeOnSuccess: true`, preserve and print every child's recovery command after the response. Set `closeOnSuccess` to false only when the parent needs to inspect a pane after that stage; pane retention does not replace response validation.
- Do not report a task as complete solely because a pane started; completion requires a settled delegate result and appropriate validation.
