import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_ENV } from "./src/constants.js";
import { registerExploreTool } from "./src/explore-tool.js";

export default function (pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;

	registerExploreTool(pi);
}
