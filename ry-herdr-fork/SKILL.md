---
name: ry-herdr-fork
description: Open Pi's previous-user-message fork selector and create the selected fork in a new Herdr tab without changing or recording anything in the current session.
compatibility: Requires Pi 0.83 or newer running inside Herdr 0.8 or newer.
---

# Fork into a New Herdr Tab

This skill invocation is normally intercepted by the package extension before
Pi expands it or writes it to the current session. The extension then opens the
same previous-user-message selector used by Pi's `/fork` command.

If these instructions reach the model, the extension is unavailable or stale.
Do not run a shell fallback because it cannot provide Pi's selector and would
leave the invocation in session history. Tell the user to run `/reload`, then
invoke `/herdr-fork` or `/skill:ry-herdr-fork` again.
