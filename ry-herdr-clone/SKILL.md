---
name: ry-herdr-clone
description: Clone Pi's current active branch into an independent session in a new Herdr tab without changing or recording anything in the current session.
compatibility: Requires Pi 0.83 or newer running inside Herdr 0.8 or newer.
---

# Clone into a New Herdr Tab

This skill invocation is normally intercepted by the package extension before
Pi expands it or writes it to the current session. The extension copies the
current active branch through its leaf, opens the independent session in a new
Herdr tab, and leaves the new Pi editor empty like native `/clone`.

If these instructions reach the model, the extension is unavailable or stale.
Do not run a shell fallback because it could clone the wrong branch and would
leave the invocation in session history. Tell the user to run `/reload`, then
invoke `/herdr-clone` or `/skill:ry-herdr-clone` again.
