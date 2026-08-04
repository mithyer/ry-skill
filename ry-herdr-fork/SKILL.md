---
name: ry-herdr-fork
description: Fork the current Pi session into a new Herdr tab. Use when the user asks to fork, clone, or duplicate the current Pi state into another Herdr tab.
compatibility: Requires Pi inside Herdr with the herdr CLI and jq available.
---

# Fork Current Pi Session

Immediately resolve `scripts/fork-current.sh` relative to this file and run it
once with `bash`.

Do not inspect Herdr topology, ask follow-up questions, or reproduce the steps
manually before running the script. The script identifies the exact session in
the calling pane, preserves focus, and removes the new tab if startup fails.

On success, report the returned tab, pane, and agent identifiers. On failure,
report the exact error and do not fall back to the most recently modified Pi
session.
