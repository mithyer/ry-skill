import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Persists a SessionManager-created session that has no assistant response yet.
 * Pi normally delays such a write, but a second process needs a concrete file
 * before it can open the prepared session with `pi --session`.
 *
 * @param manager Session manager currently pointing at the prepared session.
 * @param sessionFile Destination path returned by SessionManager.
 * @returns A promise that resolves after the file exists.
 * TEST:../ry-herdr-fork/index.test.ts[createForkSession supports forking before the root message]
 * TEST:../ry-herdr-clone/index.test.ts[createCloneSession persists an active branch without an assistant]
 */
export async function persistDeferredSession(manager: SessionManager, sessionFile: string): Promise<void> {
	if (existsSync(sessionFile)) {
		return;
	}

	const header = manager.getHeader();
	if (!header) {
		throw new Error("Prepared session has no session header");
	}

	const lines = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry));
	await writeFile(sessionFile, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
}
