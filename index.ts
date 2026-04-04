import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ExploreMode = "shallow" | "deep";

interface ExploreConfig {
	model: string;
	thinking?: ThinkingLevel;
}

interface ExtensionConfig {
	shallow?: ExploreConfig;
	deep?: ExploreConfig;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface ExploreDetails {
	mode: ExploreMode;
	toolName: string;
	task: string;
	cwd: string;
	model: string;
	thinking?: ThinkingLevel;
	messages: Message[];
	stderr: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	usage: UsageStats;
}

interface ModeSpec {
	label: string;
	shortDescription: string;
	promptPath: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const CHILD_ENV = "PI_EXPLORE_SUBAGENT_CHILD";
const TOOL_NAME = "explore_subagent";
const TOOL_LABEL = "Explore Subagent";
const SHALLOW_PROMPT_PATH = path.join(__dirname, "shallow.prompt.md");
const DEEP_PROMPT_PATH = path.join(__dirname, "deep.prompt.md");

const DEFAULT_CONFIG: Record<ExploreMode, Required<ExploreConfig>> = {
	shallow: {
		model: "openai-codex/gpt-5.3-codex-spark",
		thinking: "medium",
	},
	deep: {
		model: "openai-codex/gpt-5.4-mini",
		thinking: "low",
	},
};

const MODE_SPECS: Record<ExploreMode, ModeSpec> = {
	shallow: {
		label: "Shallow",
		shortDescription: "Surface-scan likely hotspots, entry points, and immediate relationships without drilling too far.",
		promptPath: SHALLOW_PROMPT_PATH,
	},
	deep: {
		label: "Deep",
		shortDescription: "Trace behavior more thoroughly across modules, config, scripts, and call paths.",
		promptPath: DEEP_PROMPT_PATH,
	},
};

const ALLOWED_THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeConfig(parsed: ExploreConfig | undefined, fallback: Required<ExploreConfig>): Required<ExploreConfig> {
	const model = typeof parsed?.model === "string" && parsed.model.trim() ? parsed.model.trim() : fallback.model;
	const thinking = parsed?.thinking && ALLOWED_THINKING.has(parsed.thinking) ? parsed.thinking : fallback.thinking;
	return { model, thinking };
}

function readConfig(): Record<ExploreMode, Required<ExploreConfig>> {
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

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getMode(value: unknown): ExploreMode {
	return value === "deep" ? "deep" : "shallow";
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function getToolCalls(messages: Message[]): { name: string; args: Record<string, unknown> }[] {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "toolCall") calls.push({ name: part.name, args: part.arguments });
		}
	}
	return calls;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	if (name === "read") {
		const filePath = String(args.file_path ?? args.path ?? "?");
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		const range = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
		return `read ${filePath}${range}`;
	}
	if (name === "grep") return `grep /${String(args.pattern ?? "")}/ in ${String(args.path ?? ".")}`;
	if (name === "find") return `find ${String(args.pattern ?? "*")} in ${String(args.path ?? ".")}`;
	if (name === "ls") return `ls ${String(args.path ?? ".")}`;
	if (name === "bash") return `$ ${String(args.command ?? "")}`;
	return `${name} ${JSON.stringify(args)}`;
}

async function runExplore(
	mode: ExploreMode,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((value: any) => void) | undefined,
) {
	const config = readConfig()[mode];
	const spec = MODE_SPECS[mode];
	const details: ExploreDetails = {
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

	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-skills",
		"--model",
		config.model,
		"--thinking",
		config.thinking,
		"--append-system-prompt",
		spec.promptPath,
		[
			`Run as the ${TOOL_LABEL} in ${mode} mode inside an isolated no-session subprocess.`,
			"Stay strictly in discovery mode.",
			`Mode: ${mode}`,
			`Task: ${task}`,
		].join("\n\n"),
	];

	const emitUpdate = () => {
		if (!onUpdate) return;
		const output = getFinalOutput(details.messages).trim();
		if (!output && getToolCalls(details.messages).length === 0) return;
		onUpdate({
			content: output ? [{ type: "text", text: output }] : [],
			details,
		});
	};

	let buffer = "";
	let wasAborted = false;
	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, [CHILD_ENV]: "1" },
		});

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				const message = event.message as Message;
				details.messages.push(message);
				if (message.role === "assistant") {
					details.usage.turns++;
					const usage = message.usage;
					if (usage) {
						details.usage.input += usage.input || 0;
						details.usage.output += usage.output || 0;
						details.usage.cacheRead += usage.cacheRead || 0;
						details.usage.cacheWrite += usage.cacheWrite || 0;
						details.usage.cost += usage.cost?.total || 0;
						details.usage.contextTokens = usage.totalTokens || 0;
					}
					if (message.stopReason) details.stopReason = message.stopReason;
					if (message.errorMessage) details.errorMessage = message.errorMessage;
				}
				emitUpdate();
			}
		};

		proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (chunk) => {
			details.stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});

		proc.on("error", () => resolve(1));

		if (signal) {
			const abort = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});

	details.exitCode = exitCode;
	if (wasAborted) throw new Error(`${TOOL_LABEL} aborted`);
	return details;
}

const ExploreModeSchema = StringEnum(["shallow", "deep"] as const, {
	description:
		"Reconnaissance mode. Use shallow for a bounded surface scan of likely hotspots, entry points, and immediate relationships. Use deep to trace behavior more thoroughly across modules, config, scripts, and call paths.",
	default: "shallow",
});

const ExploreParams = Type.Object({
	task: Type.String({
		description:
			"Evidence-gathering task for the subagent. This must be a full standalone brief because the subagent does not inherit the parent agent's conversation or unstated context. Include the background, exact question, relevant files or symbols, constraints, and the kind of evidence you want back. Focus the task on unresolved gaps or net-new reconnaissance rather than repeating file reads the parent agent already completed.",
	}),
	mode: Type.Optional(ExploreModeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent. Defaults to current session cwd." })),
});

export default function (pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Launch an isolated evidence-first reconnaissance subagent. The subagent is isolated and does not inherit the parent agent's conversation, plan, or unstated context, so the task must be a complete standalone brief. Use shallow mode for a bounded surface scan that identifies the most relevant files, entry points, and immediate relationships without drilling too far. Use deep mode to trace behavior more thoroughly across modules, config, scripts, and call paths before making changes. Use this for net-new reconnaissance, broader tracing, or independent verification, not to repeat file reading the parent agent already performed. This tool gathers evidence only and never edits files.",
		promptSnippet: "Run an isolated reconnaissance subagent in shallow or deep mode; provide a full standalone brief because no parent context is inherited",
		promptGuidelines: [
			"Prefer explore_subagent early when you need reconnaissance; avoid first reading the same files yourself and then asking the subagent to repeat that work.",
			"Do not use explore_subagent for questions you can already answer from files you already inspected. Use it for unresolved gaps, broader coverage, or independent verification instead.",
			"Use explore_subagent with mode=shallow when you first need a bounded surface scan of the right files, entry points, or immediate relationships.",
			"Shallow means stop early once the likely hotspots are identified; do not keep drilling unless the task explicitly asks for deeper tracing.",
			"Use explore_subagent with mode=deep when you need broader cross-file tracing before editing or deciding on an implementation.",
			"The subagent is isolated and does not inherit your conversational context, previous findings, or intent beyond the provided task and cwd.",
			"Write the task as a complete standalone brief: include background, the exact question, relevant files or symbols, constraints, and the evidence you want returned.",
			"Treat explore_subagent as evidence gathering only: it should inspect and summarize, not modify files.",
		],
		parameters: ExploreParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const mode = getMode(params.mode);
			const details = await runExplore(mode, params.task, params.cwd ?? ctx.cwd, signal, onUpdate);
			const finalOutput = getFinalOutput(details.messages) || "(no output)";
			const failed = details.exitCode !== 0 || details.stopReason === "error" || details.stopReason === "aborted";
			if (failed) {
				throw new Error(`${TOOL_LABEL} failed: ${details.errorMessage || details.stderr || finalOutput}`);
			}
			return {
				content: [{ type: "text", text: finalOutput }],
				details,
			};
		},
		renderCall(args, theme) {
			const mode = getMode(args.mode);
			const preview = args.task.length > 90 ? `${args.task.slice(0, 90)}...` : args.task;
			return new Text(`${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("accent", `[${mode}]`)}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ExploreDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const failed = details.exitCode !== 0 || details.stopReason === "error" || details.stopReason === "aborted";
			const finalOutput = getFinalOutput(details.messages) || (result.content[0]?.type === "text" ? result.content[0].text : "(no output)");
			const modelLabel = details.thinking ? `${details.model}:${details.thinking}` : details.model;
			const usage = formatUsage(details.usage);
			const toolCalls = getToolCalls(details.messages);
			const status = isPartial
				? theme.fg("warning", "… Running")
				: failed
					? theme.fg("error", "✗ Failed")
					: theme.fg("success", "✓ Done");
			const header = `${status} ${theme.fg("accent", modelLabel)}`;

			if (!expanded) {
				const previewSource = finalOutput !== "(no output)" ? finalOutput : toolCalls.at(-1) ? `→ ${formatToolCall(toolCalls.at(-1)!.name, toolCalls.at(-1)!.args)}` : finalOutput;
				const preview = previewSource.split("\n").slice(0, 8).join("\n");
				const footer = usage ? `\n${theme.fg("dim", usage)}` : "";
				return new Text(`${header}\n${preview}${footer}`, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			container.addChild(
				new Text(theme.fg("dim", `${MODE_SPECS[details.mode].label} reconnaissance · ${details.cwd}`), 0, 0),
			);
			container.addChild(new Text(theme.fg("dim", MODE_SPECS[details.mode].shortDescription), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
			container.addChild(new Text(details.task, 0, 0));
			if (toolCalls.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "Tool calls"), 0, 0));
				for (const call of toolCalls) {
					container.addChild(new Text(theme.fg("dim", `• ${formatToolCall(call.name, call.args)}`), 0, 0));
				}
			}
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Output"), 0, 0));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
			if (details.stderr.trim()) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg(failed ? "error" : "dim", details.stderr.trim()), 0, 0));
			}
			if (usage) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			}
			return container;
		},
	});
}
