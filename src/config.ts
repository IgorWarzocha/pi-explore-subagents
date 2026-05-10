import fs from "node:fs";
import { ALLOWED_THINKING, CONFIG_PATH, DEFAULT_CONFIG, TOOL_NAME } from "./constants.js";
import type { ChildRunDetails, ExploreConfig, ExploreMode, ExtensionConfig, UsageStats } from "./types.js";

function normalizeConfig(parsed: ExploreConfig | undefined, fallback: Required<ExploreConfig>): Required<ExploreConfig> {
	const model = typeof parsed?.model === "string" && parsed.model.trim() ? parsed.model.trim() : fallback.model;
	const thinking = parsed?.thinking && ALLOWED_THINKING.has(parsed.thinking) ? parsed.thinking : fallback.thinking;
	return { model, thinking };
}

export function readConfig(): Record<ExploreMode, Required<ExploreConfig>> {
	let parsed: ExtensionConfig;
	try {
		parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as ExtensionConfig;
	} catch (error) {
		throw new Error(`Could not parse ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
	}

	return {
		shallow: normalizeConfig(parsed.shallow, DEFAULT_CONFIG.shallow),
		deep: normalizeConfig(parsed.deep, DEFAULT_CONFIG.deep),
	};
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function createChildRunDetails(
	mode: ExploreMode,
	task: string,
	cwd: string,
	config = readConfig()[mode],
): ChildRunDetails {
	return {
		mode,
		toolName: TOOL_NAME,
		task,
		cwd,
		model: config.model,
		thinking: config.thinking,
		messages: [],
		stderr: "",
		exitCode: 0,
		usage: emptyUsage(),
	};
}

export function isSubagentFailure(details: Pick<ChildRunDetails, "exitCode" | "stopReason">): boolean {
	return details.exitCode !== 0 || details.stopReason === "error" || details.stopReason === "aborted";
}
