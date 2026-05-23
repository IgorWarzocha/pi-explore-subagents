import { spawn } from "node:child_process";
import { CHILD_ENV, MODE_SPECS, RPC_POLL_MS, RPC_QUIESCENCE_MS, TOOL_LABEL } from "./constants.js";
import { createChildRunDetails, readConfig } from "./config.js";
import { getFinalOutput, getToolCalls, sleep } from "./messages.js";
import type { ExploreMode } from "./types.js";

export async function runSubagent(
	mode: ExploreMode,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((value: any) => void) | undefined,
) {
	const config = readConfig()[mode];
	const spec = MODE_SPECS[mode];
	const details = createChildRunDetails(mode, task, cwd, config);
	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-skills",
		"--model",
		config.model,
		"--thinking",
		config.thinking,
		"--append-system-prompt",
		spec.promptPath,
	];
	const promptText = [
		`Run as the ${spec.label} Subagent in ${mode} mode inside an isolated no-session RPC subprocess.`,
		spec.systemPreamble,
		`Mode: ${mode}`,
		`Task: ${task}`,
	].join("\n\n");

	let lastEventAt = Date.now();
	let terminalAgentEndSeen = false;
	let retryInProgress = false;
	let promptSent = false;
	let wasAborted = false;
	let processClosed = false;
	let processExitCode: number | undefined;
	let requestId = 0;
	let stoppedAfterCompletion = false;
	let stdoutBuffer = "";
	const pendingRequests = new Map<
		string,
		{
			resolve: (value: any) => void;
			reject: (error: Error) => void;
		}
	>();

	const emitUpdate = () => {
		if (!onUpdate) return;
		const output = getFinalOutput(details.messages).trim();
		if (!output && getToolCalls(details.messages).length === 0) return;
		onUpdate({
			content: output ? [{ type: "text", text: output }] : [],
			details,
		});
	};

	const proc = spawn("pi", args, {
		cwd,
		shell: false,
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, [CHILD_ENV]: "1" },
	});

	const signalProcess = (signalName: NodeJS.Signals) => {
		if (processClosed) return;
		try {
			if (process.platform !== "win32" && proc.pid) {
				process.kill(-proc.pid, signalName);
			} else {
				proc.kill(signalName);
			}
		} catch {
			try {
				proc.kill(signalName);
			} catch {
				// Process may already be gone.
			}
		}
	};

	const rejectPendingRequests = (error: Error) => {
		for (const pending of pendingRequests.values()) {
			pending.reject(error);
		}
		pendingRequests.clear();
	};

	const sendCommand = <T = unknown>(command: Record<string, unknown>): Promise<T> => {
		if (processClosed || !proc.stdin.writable) {
			throw new Error(`Subagent RPC process is not available.${details.stderr ? ` Stderr: ${details.stderr.trim()}` : ""}`);
		}

		const id = `req_${++requestId}`;
		const payload = JSON.stringify({ ...command, id }) + "\n";

		return new Promise<T>((resolve, reject) => {
			pendingRequests.set(id, { resolve, reject });
			proc.stdin.write(payload, (error) => {
				if (!error) return;
				pendingRequests.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	};

	const handleEvent = (event: any) => {
		lastEventAt = Date.now();

		if (event.type === "message_end" && event.message) {
			const message = event.message;
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
			return;
		}

		if (event.type === "auto_retry_start") {
			retryInProgress = true;
			terminalAgentEndSeen = false;
			return;
		}

		if (event.type === "auto_retry_end") {
			retryInProgress = false;
			return;
		}

		if (event.type === "compaction_end" && event.willRetry === true) {
			retryInProgress = true;
			terminalAgentEndSeen = false;
			return;
		}

		if (event.type === "agent_end") {
			if (event.willRetry === true) {
				retryInProgress = true;
				terminalAgentEndSeen = false;
			} else {
				retryInProgress = false;
				terminalAgentEndSeen = true;
			}
		}
	};

	const handleLine = (line: string) => {
		if (!line.trim()) return;
		let data: any;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}

		if (data.type === "response" && typeof data.id === "string" && pendingRequests.has(data.id)) {
			const pending = pendingRequests.get(data.id)!;
			pendingRequests.delete(data.id);
			if (data.success === false) {
				pending.reject(new Error(typeof data.error === "string" ? data.error : `RPC ${data.command ?? "command"} failed`));
			} else {
				pending.resolve(data.data as unknown);
			}
			return;
		}

		handleEvent(data);
	};

	const stopProcess = async () => {
		if (processClosed) return;
		stoppedAfterCompletion = true;
		signalProcess("SIGTERM");
		await new Promise<void>((resolve) => proc.once("close", () => resolve()));
	};

	proc.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk.toString();
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() || "";
		for (const line of lines) handleLine(line);
	});

	proc.stderr.on("data", (chunk) => {
		details.stderr += chunk.toString();
	});

	proc.on("close", (code) => {
		processClosed = true;
		processExitCode = code ?? 0;
		if (stdoutBuffer.trim()) {
			handleLine(stdoutBuffer);
			stdoutBuffer = "";
		}
		rejectPendingRequests(new Error(`Subagent RPC process exited with code ${processExitCode}.${details.stderr ? ` Stderr: ${details.stderr.trim()}` : ""}`));
	});

	proc.on("error", (error) => {
		rejectPendingRequests(error instanceof Error ? error : new Error(String(error)));
	});

	const abort = async () => {
		if (wasAborted) return;
		wasAborted = true;
		rejectPendingRequests(new Error(`${TOOL_LABEL} aborted`));

		if (!processClosed && proc.stdin.writable) {
			const id = `req_${++requestId}`;
			proc.stdin.write(JSON.stringify({ type: "abort", id }) + "\n", () => undefined);
		}

		signalProcess("SIGTERM");
		signalProcess("SIGKILL");
	};

	if (signal) {
		if (signal.aborted) await abort();
		else signal.addEventListener("abort", () => {
			void abort();
		}, { once: true });
	}

	try {
		await sendCommand({ type: "get_state" });
		await sendCommand({ type: "set_auto_compaction", enabled: true });
		await sendCommand({ type: "set_auto_retry", enabled: true });
		await sendCommand({ type: "prompt", message: promptText });
		promptSent = true;

		while (true) {
			if (wasAborted || processClosed) break;

			await sleep(RPC_POLL_MS);

			let state: { isStreaming: boolean; isCompacting: boolean; pendingMessageCount: number };
			try {
				state = await sendCommand({ type: "get_state" });
			} catch (error) {
				if (processClosed) break;
				throw error;
			}

			const isIdle = !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0;
			const isQuiet = Date.now() - lastEventAt >= RPC_QUIESCENCE_MS;

			if (promptSent && terminalAgentEndSeen && !retryInProgress && isIdle && isQuiet) {
				break;
			}
		}
	} finally {
		await stopProcess();
	}

	details.exitCode = stoppedAfterCompletion ? 0 : (processExitCode ?? 0);
	if (wasAborted) throw new Error(`${TOOL_LABEL} aborted`);
	return details;
}
