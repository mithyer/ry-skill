#!/usr/bin/env bash

set -euo pipefail

if [[ "${HERDR_ENV:-}" != "1" || -z "${HERDR_WORKSPACE_ID:-}" || -z "${HERDR_PANE_ID:-}" ]]; then
  printf 'ry-herdr-fork: Pi is not running inside a Herdr-managed pane.\n' >&2
  exit 1
fi

for command_name in herdr jq pi; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'ry-herdr-fork: required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

session_file="$(
  herdr agent list | jq -er --arg pane "$HERDR_PANE_ID" '
    .result.agents
    | map(select(.pane_id == $pane and .agent_session.agent == "pi"))
    | .[0].agent_session.value // empty
  '
)"

if [[ -z "$session_file" || ! -f "$session_file" ]]; then
  printf 'ry-herdr-fork: no saved Pi session found for pane %s.\n' "$HERDR_PANE_ID" >&2
  exit 1
fi

timestamp="$(date +%H%M%S)"
tab_label="fork-$timestamp"
agent_name="$tab_label-$$"
created_tab_id=""

cleanup_failed_tab() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 && -n "$created_tab_id" ]]; then
    herdr tab close "$created_tab_id" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_failed_tab EXIT

tab_result="$(
  herdr tab create \
    --workspace "$HERDR_WORKSPACE_ID" \
    --cwd "$PWD" \
    --label "$tab_label" \
    --no-focus
)"

created_tab_id="$(jq -er '.result.tab.tab_id' <<<"$tab_result")"
pane_id="$(jq -er '.result.root_pane.pane_id' <<<"$tab_result")"

started=0
start_output=""
for _attempt in {1..30}; do
  if start_output="$(
    herdr agent start "$agent_name" \
      --kind pi \
      --pane "$pane_id" \
      -- \
      --fork "$session_file" \
      --name "$tab_label" \
      2>&1
  )"; then
    started=1
    break
  fi

  if [[ "$start_output" != *'"code":"agent_pane_busy"'* ]]; then
    printf '%s\n' "$start_output" >&2
    exit 1
  fi
  sleep 0.1
done

if [[ $started -ne 1 ]]; then
  printf 'ry-herdr-fork: new pane %s did not become ready within 3 seconds.\n' "$pane_id" >&2
  exit 1
fi

trap - EXIT

jq -n \
  --arg tab "$created_tab_id" \
  --arg pane "$pane_id" \
  --arg agent "$agent_name" \
  --arg session "$session_file" \
  '{status: "created", tab: $tab, pane: $pane, agent: $agent, sourceSession: $session}'
