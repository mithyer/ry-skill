import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDelegateTool } from "./tool.ts";

/** Registers the project-owned structured Herdr delegation extension. */
export default function ryHerdrDelegate(pi: ExtensionAPI): void {
	registerDelegateTool(pi);
}
