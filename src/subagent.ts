import { spawn } from "node:child_process";
import { CHILD_ENV, MODE_SPECS, RPC_POLL_MS, RPC_QUIESCENCE_MS, RPC_READY_TIMEOUT_MS, RPC_RESPONSE_TIMEOUT_MS, TOOL_LABEL } from "./constants.js";
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
	let agentEndCount = 0;
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
			timeout: ReturnType<typeof setTimeout>;
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
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, [CHILD_ENV]: "1" },
	});

	const rejectPendingRequests = (error: Error) => {
		for (const pending of pendingRequests.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		pendingRequests.clear();
	};

	const sendCommand = <T = unknown>(command: Record<string, unknown>, timeoutMs = RPC_RESPONSE_TIMEOUT_MS): Promise<T> => {
		if (processClosed || !proc.stdin.writable) {
			throw new Error(`Subagent RPC process is not available.${details.stderr ? ` Stderr: ${details.stderr.trim()}` : ""}`);
		}

		const id = `req_${++requestId}`;
		const payload = JSON.stringify({ ...command, id }) + "\n";

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				pendingRequests.delete(id);
				reject(new Error(`Timed out waiting for RPC response to ${String(command.type)}.${details.stderr ? ` Stderr: ${details.stderr.trim()}` : ""}`));
			}, timeoutMs);

			pendingRequests.set(id, { resolve, reject, timeout });
			proc.stdin.write(payload, (error) => {
				if (!error) return;
				clearTimeout(timeout);
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

		if (event.type === "agent_end") {
			agentEndCount++;
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
			clearTimeout(pending.timeout);
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
		proc.kill("SIGTERM");
		await Promise.race([
			new Promise<void>((resolve) => proc.once("close", () => resolve())),
			sleep(1_000).then(() => {
				if (!processClosed) proc.kill("SIGKILL");
			}),
		]);
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
		try {
			await sendCommand({ type: "abort" }, 5_000);
		} catch {
			if (!processClosed) proc.kill("SIGTERM");
		}
	};

	if (signal) {
		if (signal.aborted) await abort();
		else signal.addEventListener("abort", () => {
			void abort();
		}, { once: true });
	}

	try {
		await sendCommand({ type: "get_state" }, RPC_READY_TIMEOUT_MS);
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

			if (promptSent && agentEndCount > 0 && isIdle && isQuiet) {
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
