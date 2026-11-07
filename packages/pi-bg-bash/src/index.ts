/**
 * bg-bash — background execution hooked directly into the built-in bash/powershell tools.
 *
 * Overrides the built-in `bash` (and `powershell` on Windows) tool with a same-name
 * registration, adding two optional parameters the model sees in the tool schema:
 *
 *   background: true   -> run the command detached; returns a job id and output path
 *                         immediately instead of blocking the turn. The agent should end
 *                         its turn (or keep working) right away; the user can interact.
 *                         Completions are held while busy, then batched into a safe settle
 *                         draft, or sent as custom "bg-bash-result" messages when idle.
 *                         Explicit wait leases temporarily own delivery without killing work.
 *                         Offered drafts/queues are not receipts: only matching branch messages
 *                         confirm delivery, and unconfirmed outcomes remain queryable.
 *   job: "<id>"        -> OPTIONAL manual check: job "7" = status + output tail,
 *                         "7:out" = more output, "7:stop" = graceful Ctrl+C,
 *                         "7:kill" = immediate force kill of the tracked tree.
 *                         The latest 20 completions stay queryable until shutdown;
 *                         killing a completed job is a no-op.
 *
 * A `tool_call` guard blocks the "sleep to wait for a result" anti-pattern
 * (e.g. `sleep 30 && curl ...`) with an instructional error, so the model
 * learns the convention at the moment it tries to misuse sleep. Retry loops
 * (`while ... sleep ...`) are still allowed.
 *
 * Codemode scripts inherit everything automatically: scripts call tools through
 * the same registry, so `tools.bash({ command, background: true })` works, and
 * nested calls go through the `tool_call` guard too.
 *
 * Background jobs survive the turn and are watched by timers inside the pi
 * process (timers are not available to codemode scripts, but extensions have
 * them). Timers are cleared in session_shutdown; the detached OS processes
 * themselves keep writing to their temp files either way.
 *
 * Default timeout injection (replaces the external pi-timeout package): the
 * tool_call guard also injects a default timeout into foreground
 * bash/powershell calls that don't set one, so a forgotten long command can't
 * hang the turn forever. The value comes from runTimeout.maxSeconds in
 * settings.json (project .pi/settings.json overrides the global one), default
 * 120s. Explicit timeout values are always respected; background jobs are
 * never capped (the watcher manages them). Codemode scripts get a default
 * 300s deadline via an injected "// @options" line unless the script sets its
 * own timeout_ms (default 300s, configurable via runTimeout.codemodeMaxSeconds
 * in settings.json). A killed call returns the built-in timeout error (partial
 * output + cancelled), which teaches the model to retry with background:true.
 *
 * Watcher hardening: the completion watcher polls the status file, but a
 * job's subshell can die before writing it (process-tree kill by a parent
 * harness, crash, manual taskkill). When the tracked pid is no longer alive
 * and no status file exists, the job is delivered as "finished, exit unknown"
 * instead of being polled forever. Windows Bash and PowerShell jobs use a
 * native launcher PID in a separate hidden console. Unix Bash jobs use a
 * separate job-control group; neither launch path signals Pi's own console.
 *
 * Calls that set background:true are drawn with an inverted "Background" chip
 * prefixed to the shell call line in the transcript, and the delivered result
 * rows carry the same chip, so a detached launch is marked in both the collapsed
 * and expanded states.
 *
 * Load: install this package, or load a built copy from the agent's
 * extensions directory (`pi -e ./bg-bash.ts`).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Lease, ProviderDiscovery, WorkResult } from "./lib/async-work";
import { createBashTool, createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { captureProcess, hasTrackedDescendants, stopProcessTree, type ProcessIdentity, type StopMode } from "./lib/process-control";
import { readTail } from "./lib/output";
import { windowsBashLaunchScript, windowsConsoleInputPrelude } from "./lib/windows-console";
import { showJobPanel, type JobView } from "./lib/panel";

// ---------------------------------------------------------------------------
// Job registry (module state; jobs survive turns, not app restarts)
// ---------------------------------------------------------------------------

interface BgJob {
	id: number;
	tool: "bash" | "powershell";
	command: string;
	outPath: string;
	errPath?: string; // powershell only (Start-Process cannot merge streams)
	statusPath: string;
	scriptPath?: string; // Windows shell script
	pid: number | null;
	winPid?: number | null; // native OS PID (Windows Start-Process; Unix launch marker)
	identity?: ProcessIdentity;
	identityReady?: Promise<void>;
	stopUnavailable?: string;
	stopping?: Promise<string>;
	stopMode?: StopMode;
	stopFailed?: boolean;
	startedAt: number;
	timer?: ReturnType<typeof setInterval>;
	result?: { exit: string; secs: number };
	sessionFile?: string;
	ctx: ExtensionContext;
	outcome?: WorkResult;
	completion: Promise<WorkResult>;
	resolve: (result: WorkResult) => void;
	owner?: string;
	consumed?: boolean;
	submitted?: boolean;
	deliveryId?: string;
	confirmed?: boolean;
	scope: number;
}

const jobs = new Map<number, BgJob>();
const MAX_COMPLETED_JOBS = 20;
let nextJobId = 1;
let currentCtx: ExtensionContext | undefined;
let sessionEpoch = new AbortController();
let sessionScope = 0;
let idleFlush: ReturnType<typeof setTimeout> | undefined;

function currentSession(ctx: ExtensionContext): boolean {
	return !!currentCtx && !sessionEpoch.signal.aborted &&
		ctx.sessionManager.getSessionFile() === currentCtx.sessionManager.getSessionFile();
}

function currentJob(job: BgJob): boolean {
	return !!currentCtx && job.scope === sessionScope && currentSession(job.ctx) &&
		job.sessionFile === currentCtx.sessionManager.getSessionFile();
}

function updateJobStatus(): void {
	try {
		if (!currentCtx?.hasUI) return;
		const running = [...jobs.values()].filter(job => currentJob(job) && !job.result).length;
		currentCtx.ui.setStatus("bg-bash", running ? `BG: ${running} running · /bg` : undefined);
	} catch { /* A stale UI must not affect process execution or delivery. */ }
}

function invalidateSession(ctx?: ExtensionContext, replace = false): void {
	try { if (currentCtx?.hasUI) currentCtx.ui.setStatus("bg-bash", undefined); } catch { /* Stale UI. */ }
	if (idleFlush !== undefined) clearTimeout(idleFlush);
	idleFlush = undefined;
	sessionEpoch.abort(new Error("Shell wait invalidated by session change"));
	sessionEpoch = new AbortController();
	if (replace) sessionScope++;
	currentCtx = ctx;
	updateJobStatus();
}

// ---------------------------------------------------------------------------
// Schema: built-in params plus background/job
// ---------------------------------------------------------------------------

const bgSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run the command detached in the background: returns a job id and output path immediately instead of blocking this call. The command's output is not lost - it is saved to a file you can read later.",
		}),
	),
	job: Type.Optional(
		Type.String({
			description:
				`Background job id returned by a previous background:true call. "7" = status + last 40 output lines, "7:out" = last 80 output lines, "7:stop" = graceful Ctrl+C (no automatic escalation), "7:kill" = force kill the tracked process tree without grace (no-op if completed). The latest ${MAX_COMPLETED_JOBS} completed jobs remain queryable until shutdown. When set, command is ignored.`,
		}),
	),
});

const DEFAULT_SHELL_TIMEOUT_S = 120;
const DEFAULT_CODEMODE_TIMEOUT_S = 300;

const GUIDELINE =
	"Long-running or blocking commands (builds, dev servers, installs, test suites, network waits): set " +
	"background:true — you get a job id immediately while the command runs detached, and its exit code and " +
	"output tail are delivered automatically when safe. Do independent work after dispatch; when blocked, " +
	"use wait with explicit shell:<id>/agent:<id> jobs, or end your turn for push delivery. Do not answer redundant known result messages individually. On-demand checks without waiting: " +
	"job:\"<id>\" (status), \"<id>:out\" (more output), \"<id>:stop\" (graceful), \"<id>:kill\" (force). Use wait instead of sleep or polling — " +
	"sleep-waits and poll loops are blocked. Foreground calls without an explicit timeout are killed after " +
	`${DEFAULT_SHELL_TIMEOUT_S}s (runTimeout.maxSeconds) - set timeout for a different cap, or use background:true ` +
	"for anything that may run longer.";

// Codemode gets its own, higher default: image generation can legitimately
// run for minutes.
const CODEMODE_GUIDELINE =
	`Codemode scripts get a default ${DEFAULT_CODEMODE_TIMEOUT_S}s deadline (timeout_ms, configurable via ` +
	`runTimeout.codemodeMaxSeconds) unless the script starts with its own // @options line setting timeout_ms. ` +
	`For longer work, set your own deadline or run the long step via tools.bash with background:true.`;

// ---------------------------------------------------------------------------
// Default timeout injection (replaces the external pi-timeout package)
// ---------------------------------------------------------------------------

// Timeout settings: runTimeout.maxSeconds caps foreground shell calls and
// runTimeout.codemodeMaxSeconds caps codemode scripts (project
// .pi/settings.json overrides the global one), positive numbers only - the
// built-in tool rejects non-positive timeouts with a validation error.
let cachedShellTimeoutS: number | undefined;
let cachedCodemodeTimeoutS: number | undefined;

function runTimeoutSetting(key: "maxSeconds" | "codemodeMaxSeconds"): number | undefined {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	let value: unknown;
	for (const path of [join(agentDir, "settings.json"), join(process.cwd(), ".pi", "settings.json")]) {
		try {
			const settings = JSON.parse(readFileSync(path, "utf8")) as { runTimeout?: Record<string, unknown> };
			const entry = settings?.runTimeout?.[key];
			if (typeof entry === "number") value = entry;
		} catch {
			// Missing or invalid file - keep whatever the previous file set.
		}
	}
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function shellTimeoutSeconds(): number {
	return (cachedShellTimeoutS ??= runTimeoutSetting("maxSeconds") ?? DEFAULT_SHELL_TIMEOUT_S);
}

function codemodeTimeoutSeconds(): number {
	return (cachedCodemodeTimeoutS ??= runTimeoutSetting("codemodeMaxSeconds") ?? DEFAULT_CODEMODE_TIMEOUT_S);
}

type ShellToolInput = { command?: unknown; timeout?: unknown; background?: unknown; job?: unknown };

function injectShellTimeout(input: ShellToolInput): void {
	// Background jobs are watcher-managed and never capped; explicit timeouts
	// and job-management calls (input.job) are always respected.
	if (input.background === true || input.job !== undefined) return;
	if (typeof input.command !== "string" || input.timeout !== undefined) return;
	input.timeout = shellTimeoutSeconds();
}

// Codemode has no default deadline; give scripts one by injecting or merging
// a "// @options" first line unless the script already sets timeout_ms.
const OPTIONS_LINE_RE = /^\/\/\s*@options:\s*(\{.*\})\s*$/;

function injectCodemodeTimeout(input: { code?: unknown }): void {
	if (typeof input.code !== "string") return;
	const timeoutMs = codemodeTimeoutSeconds() * 1000;
	const lines = input.code.split("\n");
	const first = lines.findIndex((line) => line.trim() !== "");
	if (first !== -1 && OPTIONS_LINE_RE.test(lines[first])) {
		try {
			const opts = JSON.parse(lines[first].match(OPTIONS_LINE_RE)![1]) as Record<string, unknown>;
			if (opts && typeof opts === "object" && opts.timeout_ms === undefined) {
				opts.timeout_ms = timeoutMs;
				lines[first] = `// @options: ${JSON.stringify(opts)}`;
				input.code = lines.join("\n");
			}
		} catch {
			// Unparsable options line - leave the script untouched.
		}
		return;
	}
	input.code = `// @options: {"timeout_ms": ${timeoutMs}}\n` + input.code;
}

// ---------------------------------------------------------------------------
// Launch wrappers (delegate to the real tool so shell config, env, cwd,
// truncation and rendering all stay pi's own)
// ---------------------------------------------------------------------------

function bashLaunchWrap(command: string, outPath: string, statusPath: string): string {
	// Job control gives the detached job its own group and avoids Bash's usual
	// ignored SIGINT disposition for asynchronous commands. Signal verified PIDs,
	// not an unchecked process group. Windows uses a separate native console.
	return `set -m; ( ${command}\necho $? > "${statusPath}" ) > "${outPath}" 2>&1 & ` +
		`BG_PID=$!; echo "__PI_BG_PID:$BG_PID __PI_BG_WINPID:$BG_PID"`;
}

function psScriptFor(command: string, statusPath: string): string {
	return [
		windowsConsoleInputPrelude,
		"$ErrorActionPreference = 'Continue'",
		command,
		`"exit=$LASTEXITCODE ok=$?" | Set-Content -LiteralPath '${statusPath.replace(/'/g, "''")}'`,
		"",
	].join("\n");
}

function windowsLaunchWrap(scriptPath: string, outPath: string, errPath: string): string {
	const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
	// Start-Process joins ArgumentList: quote the script argument itself for spaces.
	const scriptArg = literal(`"${scriptPath.replace(/\\/g, "/")}"`);
	const executable = "$command = Get-Command pwsh -ErrorAction SilentlyContinue; " +
		"if (-not $command) { $command = Get-Command powershell -ErrorAction Stop }; $exe = $command.Source; ";
	const args = `@('-NoProfile','-ExecutionPolicy','Bypass','-File',${scriptArg})`;
	// No -NoNewWindow: a new hidden console prevents Ctrl+C reaching Pi. The
	// interrupt helper still authenticates console membership before signaling.
	return "$ErrorActionPreference = 'Stop'; " + executable +
		`$p = Start-Process -FilePath $exe -ArgumentList ${args} -WorkingDirectory (Get-Location).ProviderPath ` +
		`-RedirectStandardOutput ${literal(outPath)} -RedirectStandardError ${literal(errPath)} ` +
		"-WindowStyle Hidden -PassThru; \"__PI_BG_PID:$($p.Id) __PI_BG_WINPID:$($p.Id)\"";
}

// ---------------------------------------------------------------------------
// Check / kill commands (also executed through the real tool)
// ---------------------------------------------------------------------------

function bashStatusCmd(job: BgJob): string {
	return (
		`if [ -f "${job.statusPath}" ]; then echo "DONE (exit $(cat "${job.statusPath}"))"; ` +
		`else echo "RUNNING ($(( $(date +%s) - ${job.startedAt} ))s)"; fi; ` +
		`echo "--- last output ---"; tail -n 40 "${job.outPath}" 2>/dev/null || echo "(no output yet)"`
	);
}

function bashOutCmd(job: BgJob): string {
	return `tail -n 80 "${job.outPath}" 2>/dev/null || echo "(no output yet)"`;
}

function psStatusCmd(job: BgJob): string {
	return (
		`if (Test-Path -LiteralPath '${job.statusPath}') { "DONE - " + (Get-Content -LiteralPath '${job.statusPath}' -Raw).Trim() } ` +
		`else { "RUNNING ($([int]((Get-Date) - ([datetime]'${new Date(job.startedAt).toISOString()}')).TotalSeconds))s" }; ` +
		`"--- last output ---"; if (Test-Path -LiteralPath '${job.outPath}') { Get-Content -LiteralPath '${job.outPath}' -Tail 40 } ` +
		`else { "(no output yet)" }; ` +
		`"--- stderr ---"; if (Test-Path -LiteralPath '${job.errPath}') { Get-Content -LiteralPath '${job.errPath}' -Tail 20 }`
	);
}

function psOutCmd(job: BgJob): string {
	return (
		`if (Test-Path -LiteralPath '${job.outPath}') { Get-Content -LiteralPath '${job.outPath}' -Tail 80 } ` +
		`else { "(no output yet)" }`
	);
}

// ---------------------------------------------------------------------------
// Completion watcher: poll the status file, hold outcomes while busy, and
// deliver only at an actionable settle boundary or an idle fallback. A wait
// lease owns delivery until commit/release. Submitted drafts and native queues
// cannot be safely retracted/retried; branch receipts alone confirm delivery.
// ---------------------------------------------------------------------------

function tailFile(path: string, lines: number): string {
	return readTail(path, lines);
}

function stopWatcher(job: BgJob) {
	if (job.timer) {
		clearInterval(job.timer);
		job.timer = undefined;
	}
}

// signal 0 probes existence without signaling; EPERM means the process exists
// but we may not signal it. Anything else (ESRCH) means it is gone.
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

// Render a finished-message body with left padding matching other custom
// messages, no background box - compact-tools aesthetic.
function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// Delete leftover pi-bg-* temp files (out/status/err) older than maxAgeMs.
// Runs at session_start and session_shutdown; files younger than the cutoff
// stay readable for agents still referencing them from delivered messages.
function sweepOldJobFiles(maxAgeMs = 24 * 60 * 60 * 1000) {
	try {
		const dir = tmpdir();
		const cutoff = Date.now() - maxAgeMs;
		for (const name of readdirSync(dir)) {
			if (!name.startsWith("pi-bg-")) continue;
			const path = join(dir, name);
			try {
				if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
			} catch {
				// Vanished mid-sweep or locked - skip.
			}
		}
	} catch {
		// No temp dir access - cleanup is best-effort.
	}
}

function trimHistory() {
	// Returning a draft / sendMessage is only an offer, not branch acceptance.
	try {
		if (currentCtx) {
			const receipts = new Set(currentCtx.sessionManager.getBranch().flatMap((entry) =>
				entry.type === "message" && entry.message.role === "custom" && entry.message.customType === "bg-bash-result"
					? [(entry.message.details as { deliveryId?: string } | undefined)?.deliveryId] : []));
			for (const job of jobs.values()) {
				if (currentJob(job) && job.submitted && job.deliveryId && receipts.has(job.deliveryId)) job.confirmed = true;
			}
		}
	} catch {
		// Receipt lookup is best-effort during navigation; retain unconfirmed offers.
	}
	const completed = [...jobs.values()].filter((job) => job.result && !job.owner && (job.consumed || job.confirmed) &&
		!job.identityReady && !(job.identity && hasTrackedDescendants(job.identity)));
	for (const oldest of completed.slice(0, -MAX_COMPLETED_JOBS)) jobs.delete(oldest.id);
}

// One transition for watcher, claim and query: never read/deliver the same completion twice.
function refreshCompletion(job: BgJob): void {
	if (job.result || job.stopping || job.stopFailed) return;
	const statusExists = existsSync(job.statusPath);
	const unknownExit = !statusExists && job.winPid != null && job.winPid > 0 && !processAlive(job.winPid);
	if (!statusExists && !unknownExit) return;
	let exit = "?";
	if (!unknownExit) {
		try { exit = readFileSync(job.statusPath, "utf8").trim(); } catch { return; }
		// A status file can be visible before its writer writes the exit code.
		if (!exit) return;
	}
	finishJob(job, unknownExit ? "unknown - the process died before writing its status file" : exit);
}

function finishJob(job: BgJob, exitLabel: string): void {
	if (job.result) return;
	stopWatcher(job);
	const secs = Math.max(1, Math.floor(Date.now() / 1000) - job.startedAt);
	const tail = tailFile(job.outPath, 40);
	const errTail = job.errPath ? tailFile(job.errPath, 20) : "";
	job.result = { exit: exitLabel, secs };
	job.outcome = {
		source: "shell", id: job.id,
		content: `[bg-bash] Background job #${job.id} finished (exit ${exitLabel}) after ${secs}s.` +
			`
Command: ${job.command}` +
			`
--- output (last 40 lines; full file: ${job.outPath}) ---
${tail || "(no output)"}` +
			(errTail ? `
--- stderr ---
${errTail}` : ""),
		details: { jobId: job.id, exit: exitLabel, secs, command: job.command, outPath: job.outPath, tail, errTail },
	};
	jobs.delete(job.id);
	jobs.set(job.id, job);
	job.resolve(job.outcome);
	trimHistory();
	updateJobStatus();
}

/** Both the model and /bg use this transition; a wait lease retains delivery ownership. */
function stopJob(pi: ExtensionAPI, job: BgJob, by: "user" | "agent", mode: StopMode = "graceful"): Promise<string> {
	if (!currentJob(job)) return Promise.reject(new Error("Job belongs to another session"));
	if (job.stopping) {
		// Never report an in-flight graceful request as a completed force kill.
		return mode === "force" && job.stopMode !== "force" ?
			job.stopping.catch(() => {}).then(() => stopJob(pi, job, by, mode)) : job.stopping;
	}
	refreshCompletion(job);
	if (job.result && !job.identityReady && !(job.identity && hasTrackedDescendants(job.identity))) {
		return Promise.resolve(`Background job #${job.id} already finished; no signal sent.`);
	}
	job.stopMode = mode;
	job.stopping = Promise.resolve().then(async () => {
		await job.identityReady;
		if (job.result && !(job.identity && hasTrackedDescendants(job.identity))) {
			return `Background job #${job.id} already finished; no signal sent.`;
		}
		if (!job.identity) throw new Error(job.stopUnavailable ?? "No verified process identity; refusing to stop an unverified PID");
		const hadResult = !!job.result;
		const outcome = await stopProcessTree(job.identity, mode);
		if (outcome === "stuck") throw new Error(mode === "graceful" ?
			"Some tracked processes are still running; use Force kill to terminate survivors. No automatic escalation was performed." :
			"Some tracked processes are still running; cleanup is incomplete and can be retried");
		job.stopping = undefined;
		job.stopFailed = false;
		if (hadResult) {
			// Command completion and child cleanup are distinct. Preserve its original
			// result/lease and never send a second completion for leftover cleanup.
			trimHistory();
			return outcome === "gone" ? `Background job #${job.id}'s tracked processes were already gone; no signal sent.` :
				`Background job #${job.id}'s tracked process tree is gone; its command result is unchanged.`;
		}
		if (outcome === "gone") refreshCompletion(job);
		if (!job.result) finishJob(job, outcome === "gone" ? "unknown - process already gone" :
			`${mode === "force" ? "force killed" : "stopped gracefully"} by ${by}`);
		if (!job.owner && !job.submitted && !job.consumed) {
			if (by === "agent") job.consumed = true;
			else if (currentJob(job)) {
				// Record the stop for the next normal turn, without waking an idle model.
				job.submitted = true;
				const { type: _type, ...message } = resultDraft(job);
				try { pi.sendMessage(message, { triggerTurn: false, deliverAs: "followUp" }); }
				catch { /* Acceptance is uncertain; retain the queryable result without retrying. */ }
			}
		}
		return outcome === "gone" ? `Background job #${job.id} was already gone; no signal sent.` :
			`Background job #${job.id} stopped; its tracked process tree is gone.`;
	}).catch(error => { if (job.identity) job.stopFailed = true; throw error; })
		.finally(() => { job.stopping = undefined; job.stopMode = undefined; updateJobStatus(); });
	updateJobStatus();
	return job.stopping;
}

function visibleJobs(): JobView[] {
	const visible = [...jobs.values()].filter(currentJob);
	return visible.sort((a, b) => Number(!b.result) - Number(!a.result) || b.id - a.id).map(job => {
		const children = !!job.identity && hasTrackedDescendants(job.identity);
		return {
			id: job.id, command: job.command, tool: job.tool, running: !job.result,
			stoppable: !job.result || !!job.identityReady || children,
			state: job.stopping ? (job.stopMode === "force" ? "force killing" : "stopping gracefully") : job.result ?
				`done, ${job.result.exit}${job.stopFailed ? " · cleanup incomplete" : children ? " · child cleanup available" : ""}` :
				job.stopFailed ? "cleanup incomplete" : job.identity ? "running" :
				job.identityReady ? "running (verifying PID)" : "running (stop unavailable)",
			secs: job.result?.secs ?? Math.max(0, Math.floor(Date.now() / 1000) - job.startedAt),
		};
	});
}

function resultDraft(job: BgJob) {
	job.deliveryId ??= crypto.randomUUID();
	return { type: "custom_message" as const, customType: "bg-bash-result", content: job.outcome!.content,
		display: true, details: { ...job.outcome!.details, deliveryId: job.deliveryId } };
}

function pushIfIdle(pi: ExtensionAPI, job: BgJob) {
	try {
		if (!job.outcome || job.owner || job.consumed || job.submitted ||
			!currentJob(job) || !currentCtx!.isIdle() || currentCtx!.hasPendingMessages()) return;
		// Mark first: an accepted native queue cannot safely be retracted by wait.
		job.submitted = true;
		const { type: _type, ...message } = resultDraft(job);
		pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
	} catch {
		// A synchronous throw may follow acceptance. Keep the offer protected and
		// queryable; neither wait nor automatic delivery may blindly retry it.
	}
	trimHistory();
}

function startWatcher(pi: ExtensionAPI, job: BgJob) {
	job.timer = setInterval(() => {
		refreshCompletion(job);
		pushIfIdle(pi, job);
	}, 1500);
}

function claimJobs(pi: ExtensionAPI, epoch: AbortSignal, sessionFile: string | undefined, ids: number[], owner: string): Lease {
	if (epoch.aborted || epoch !== sessionEpoch.signal || !currentCtx) throw new Error("Shell provider invalidated by session change");
	if (!owner || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
		throw new Error("Invalid shell job IDs or owner");
	const claimed = ids.map((id) => {
		const job = jobs.get(id);
		if (!job || !currentJob(job) || job.sessionFile !== sessionFile) throw new Error(`Unknown shell job ${id} for this session`);
		if (job.consumed) throw new Error(`shell:${id} result already consumed`);
		if (job.submitted) throw new Error(`shell:${id} result already submitted externally; native queues cannot be retracted safely`);
		if (job.owner) throw new Error(`shell:${id} already claimed by ${job.owner}`);
		return job;
	});
	for (const job of claimed) { job.owner = owner; refreshCompletion(job); }
	let active = true;
	let invalidate!: () => void;
	const result = new Promise<WorkResult[]>((resolve, reject) => {
		invalidate = () => {
			if (active) for (const job of claimed) job.owner = undefined;
			active = false;
			reject(new Error("Shell wait invalidated by session change"));
		};
		epoch.addEventListener("abort", invalidate, { once: true });
		Promise.all(claimed.map((job) => job.completion)).then((outcomes) => {
			if (epoch.aborted) return;
			if (!active) epoch.removeEventListener("abort", invalidate);
			resolve(outcomes);
		});
	});
	// A later provider may fail group acquisition before wait observes this promise.
	// Keep the original rejection visible to callers without an unhandled rejection.
	void result.catch(() => {});
	return {
		result,
		commit() {
			if (!active) return;
			active = false;
			if (claimed.every((job) => job.outcome)) epoch.removeEventListener("abort", invalidate);
			for (const job of claimed) { job.consumed = true; job.owner = undefined; }
			trimHistory();
		},
		release() {
			if (!active) return;
			active = false;
			if (claimed.every((job) => job.outcome)) epoch.removeEventListener("abort", invalidate);
			for (const job of claimed) { job.owner = undefined; pushIfIdle(pi, job); }
			trimHistory();
		},
	};
}

// ---------------------------------------------------------------------------
// Tool override
// ---------------------------------------------------------------------------

type ShellTool = ReturnType<typeof createBashTool>;
type ShellParams = { command: string; timeout?: number; background?: boolean; job?: string };

function registerBgTool(pi: ExtensionAPI, toolName: "bash" | "powershell", builtIn: ShellTool) {
	builtIn.description =
		`Execute a ${toolName} command in the current working directory. Returns stdout and stderr. ` +
		`Output is truncated to the last lines/KB; if truncated, full output is saved to a temp file. ` +
		`For long-running or blocking commands (builds, servers, installs, tests, waits), set background:true: ` +
		`the call returns a job id immediately, the command runs detached, and its exit code and output tail are ` +
		`delivered to you automatically as a new message when it finishes. A background call can be followed up ` +
		`with job:"<id>" (status + output tail), "<id>:out" (more output), "<id>:stop" (graceful, no automatic escalation), or "<id>:kill" (immediate force kill of the tracked tree). ` +
		`The latest ${MAX_COMPLETED_JOBS} completed jobs remain queryable until shutdown; killing one is a no-op. ` +
		`Do independent work first; when blocked use wait({jobs:["shell:<id>"]}) or end your turn. Sleep-waits and poll loops are blocked. ` +
		`Foreground calls without an explicit timeout are killed after ${shellTimeoutSeconds()}s - set timeout for ` +
		`a different cap, or use background:true for anything that may run longer.`;

	pi.registerTool({
		name: toolName,
		label: toolName,
		description: builtIn.description,
		parameters: bgSchema,
		promptSnippet: (builtIn as { promptSnippet?: string }).promptSnippet,
		promptGuidelines: [...((builtIn as { promptGuidelines?: string[] }).promptGuidelines ?? []), GUIDELINE],

		async execute(
			_toolCallId: string,
			params: ShellParams,
			signal: AbortSignal | undefined,
			onUpdate: any,
			ctx: any,
		) {
			const exec = (command: string, timeout?: number) =>
				(builtIn.execute as (...args: unknown[]) => unknown)(_toolCallId, { command, timeout }, signal, onUpdate, ctx);

			// Job management: build the check command and run it through the real tool.
			if (params.job) {
				const m = params.job.match(/^(\d+)(?::(out|stop|kill))?$/);
				const job = m ? jobs.get(Number(m[1])) : undefined;
				if (!job || !currentSession(ctx) || !currentJob(job)) {
					const known = [...jobs.values()].filter(currentJob).map((job) => String(job.id)).join(", ") || "none";
					throw new Error(`Unknown background job "${params.job}". Known jobs: ${known}.`);
				}
				const action = m![2] ?? "status";
				// The watcher and queries use one transition; queries can consume before any enqueue.
				refreshCompletion(job);
				const cleanupRequest = (action === "kill" || action === "stop") &&
					(!!job.identityReady || !!job.identity && hasTrackedDescendants(job.identity));
				if (job.result && !cleanupRequest) {
					if (!job.owner && !job.submitted) job.consumed = true;
					trimHistory();
					const errTail = action === "status" && job.errPath ? tailFile(job.errPath, 20) : "";
					const text = action === "kill" || action === "stop"
						? `Background job #${job.id} already finished; no signal sent.`
						: action === "out"
							? tailFile(job.outPath, 80)
							: `DONE (exit ${job.result.exit}) after ${job.result.secs}s.\n--- last output ---\n${tailFile(job.outPath, 40)}` +
								(errTail ? `\n--- stderr ---\n${errTail}` : "");
					return { content: [{ type: "text", text }], details: { bgJob: job.id, bgOutputPath: job.outPath, ...job.result } } as never;
				}
				if (action === "kill" || action === "stop") {
					const text = await stopJob(pi, job, "agent", action === "kill" ? "force" : "graceful");
					return { content: [{ type: "text", text }], details: { bgJob: job.id, ...job.result } } as never;
				}
				const cmd = job.tool === "bash"
					? action === "out" ? bashOutCmd(job) : bashStatusCmd(job)
					: action === "out" ? psOutCmd(job) : psStatusCmd(job);
				return exec(cmd, 15) as never;
			}

			// Background launch.
			if (params.background) {
				if (!currentSession(ctx)) throw new Error("Shell session invalidated");
				const epoch = sessionEpoch.signal;
				const id = nextJobId++;
				const stamp = `${id}-${Date.now()}`;
				let resolve!: (result: WorkResult) => void;
				const completion = new Promise<WorkResult>((done) => { resolve = done; });
				const job: BgJob = {
					id, completion, resolve, ctx, scope: sessionScope, sessionFile: ctx.sessionManager.getSessionFile(),
					tool: toolName,
					command: params.command,
					outPath: join(tmpdir(), `pi-bg-${stamp}.out`),
					statusPath: join(tmpdir(), `pi-bg-${stamp}.status`),
					pid: null,
					startedAt: Math.floor(Date.now() / 1000),
				};
				if (toolName === "bash") {
					let launch: string;
					if (process.platform === "win32") {
						job.scriptPath = join(tmpdir(), `pi-bg-${stamp}.ps1`);
						job.errPath = join(tmpdir(), `pi-bg-${stamp}.err`);
						const commandPath = join(tmpdir(), `pi-bg-${stamp}.sh`);
						const status = job.statusPath.replace(/\\/g, "/").replace(/'/g, "'\\''");
						writeFileSync(commandPath, `exec 2>&1\n${params.command}\necho $? > '${status}'\n`, "utf8");
						// The console bootstrap clears inherited Ctrl+C suppression before
						// Bash (and its native child processes) inherit the job console.
						writeFileSync(job.scriptPath, windowsBashLaunchScript(commandPath), "utf8");
						const launcher = windowsLaunchWrap(job.scriptPath, job.outPath, job.errPath);
						launch = `PI_BG_BASH_EXECUTABLE="$(cygpath -w "$BASH")" powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(launcher, "utf16le").toString("base64")}`;
					} else launch = bashLaunchWrap(params.command, job.outPath, job.statusPath);
					const result = await exec(launch, 15) as { content?: Array<{ text?: string }> };
					const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
					const pid = text.match(/__PI_BG_PID:(\d+)/)?.[1];
					const winPid = text.match(/__PI_BG_WINPID:(\d+)/)?.[1];
					job.pid = pid ? Number(pid) : null;
					job.winPid = winPid ? Number(winPid) : null;
				} else {
					job.scriptPath = join(tmpdir(), `pi-bg-${stamp}.ps1`);
					job.errPath = join(tmpdir(), `pi-bg-${stamp}.err`);
					writeFileSync(job.scriptPath, psScriptFor(params.command, job.statusPath), "utf8");
					const result = await exec(windowsLaunchWrap(job.scriptPath, job.outPath, job.errPath), 30) as {
						content?: Array<{ text?: string }>;
					};
					const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
					const pid = text.match(/__PI_BG_PID:(\d+)/)?.[1];
					job.pid = pid ? Number(pid) : null;
					// Both Windows launch paths return native PIDs, not MSYS identifiers.
					job.winPid = job.pid;
				}
				if (!job.pid || (process.platform === "win32" && !job.winPid)) {
					throw new Error(`Background launch did not return a native PID; inspect ${job.outPath}${job.errPath ? ` and ${job.errPath}` : ""}`);
				}
				const osPid = process.platform === "win32" ? job.winPid : job.pid;
				// Identity discovery must not turn a detached launch back into blocking work.
				job.identityReady = (osPid == null ? Promise.reject(new Error("The shell did not return a real OS PID")) :
					captureProcess(osPid, epoch)).then(identity => { job.identity = identity; })
					.catch(error => { job.stopUnavailable = `Cannot verify this job's process identity: ${String(error)}`; })
					.finally(() => {
						job.identityReady = undefined;
						if (currentJob(job)) { trimHistory(); updateJobStatus(); }
					});
				jobs.set(id, job);
				if (!epoch.aborted && currentJob(job)) startWatcher(pi, job);
				updateJobStatus();
				return {
					content: [
						{
							type: "text",
							text:
								`Background job #${id} started${job.pid ? ` (pid ${job.pid})` : ""}.\n` +
								`Output file: ${job.outPath}\n\n` +
								`Its exit code and output tail will be delivered to you automatically as a new message.\n` +
								`End your turn now or keep working on something else; on-demand checks: job:"${id}" (status), "${id}:out" (output), "${id}:stop" (graceful), "${id}:kill" (force).`,
						},
					],
					details: { bgJob: id, bgOutputPath: job.outPath },
				} as never;
			}

			// Normal foreground call - identical to the built-in tool.
			return exec(params.command, params.timeout) as never;
		},
	});
}

// ---------------------------------------------------------------------------
// sleep-wait guard: block "use sleep to wait for a result" calls with a
// self-teaching error. Retry loops (while/until ... sleep/Start-Sleep) pass.
// ---------------------------------------------------------------------------

const BASH_WAIT_PATTERNS = [
	/^\s*sleep\s+[\d.]/, // sleep 30 ...
	/(?:&&|\|\||;|&)\s*sleep\s+[\d.]+\s*(?:&&|$)/, // ... && sleep 30 / sleep 30 && ...
];
const PS_WAIT_PATTERNS = [
	/^\s*Start-Sleep\b/i,
	/(?:;|\|)\s*Start-Sleep\b/i,
];

function isWaitForSleep(toolName: string, command: string): boolean {
	const isBash = toolName === "bash";
	const patterns = isBash ? BASH_WAIT_PATTERNS : PS_WAIT_PATTERNS;
	// Retry loops (while/until/for ... do ... done) are a legitimate place for sleep.
	if (isBash && /\b(while|until|for)\b/.test(command) && /\bdo\b/.test(command) && /\bdone\b/.test(command)) return false;
	if (!isBash && (/\b(while|foreach)\b/.test(command) || /\bfor\s*\(/.test(command))) return false;
	return patterns.some((re) => re.test(command));
}

// ---------------------------------------------------------------------------
// "Background" call badge
// ---------------------------------------------------------------------------

// Prepends a purple "Background" chip to every bash/powershell call that sets
// background:true, marking a detached launch in the transcript. Uses the same
// inverted fill as the result rows below so the two read as one visual family.
// Registered as a tool renderer resolver (not a per-tool renderCall) so it also
// covers the powershell tool, which is registered later on session_start, and
// delegates non-background calls to the shell renderer untouched. Note: a
// resolver registered earlier that fully owns bash/powershell without calling
// next() (compact-tools does this for known names) would shadow this badge.
function registerBackgroundCallBadge(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== "bash" && toolName !== "powershell") return next();
		const base = next();
		const baseRenderCall = base?.renderCall;
		// No underlying call renderer (e.g. the HTML-export path resolves the
		// bare registered definition): leave rendering to the host's default
		// instead of substituting an empty component.
		if (!baseRenderCall) return base;
		return {
			...base,
			renderCall(args, theme, context) {
				const comp = baseRenderCall(args, theme, context);
				if ((args as { background?: boolean } | undefined)?.background !== true) return comp;
				// Reuse the underlying call component rather than re-deriving the shell
				// line, so its formatting (compact-tools' collapsed cap, pi's command
				// fallback and timeout suffix) stays the single source of truth; only
				// prefix the badge. Underlying renderers may return a pi-tui Text (with
				// setText) or a duck-typed component with a mutable `text` field and a
				// cache to invalidate (compact-tools' ShellCallLine), so handle both.
				const line = comp as unknown as { text?: unknown; setText?: (t: string) => void; invalidate?: () => void };
				if (typeof line.text !== "string") return comp;
				const badged = `${theme.inverse(theme.bold(" Background "))} ${line.text}`;
				if (typeof line.setText === "function") {
					line.setText(badged);
				} else {
					line.text = badged;
					line.invalidate?.();
				}
				return comp;
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

// Collapsed cap for the delivered result line: at most this many visual
// (wrapped) lines, mirroring compact-tools' shell call-line behavior — the
// overflow is cut off at terminal width with a dim hint naming the hidden
// line count. Measured in rendered lines so it adapts to terminal width.
const MAX_RESULT_LINES = 1;

// Cut text to maxLines visual lines at the given width, appending the same
// "… (+N more lines)" hint compact-tools uses.
function capLines(text: string, maxLines: number, width: number, theme: any): string[] {
	const lines = new Text(text, 0, 0).render(width);
	if (lines.length <= maxLines) return lines;
	const hidden = lines.length - maxLines;
	const hint = theme.fg("dim", ` … (+${hidden} more line${hidden === 1 ? "" : "s"})`);
	const kept = lines.slice(0, maxLines);
	const last = kept[kept.length - 1].replace(/\s+$/, "");
	const avail = Math.max(0, width - visibleWidth(hint));
	kept[kept.length - 1] = avail > 0 ? truncateToWidth(last, avail, "") + hint : truncateToWidth(last, width, "…");
	return kept;
}

interface BgResultDetails {
	jobId?: number;
	exit?: string;
	secs?: number;
	command?: string;
	outPath?: string;
	tail?: string;
	errTail?: string;
}

// Stateful rendered row for a finished bg job, mirroring how
// ToolExecutionComponent behaves: flush single-line collapsed view with the
// cap hint, click-to-expand via handleMouse (same event contract tool rows
// use), and setExpanded for ctrl+o (app.tools.expand) which the host message
// component forwards. Purple customMessageBg keeps it visually distinct from
// synchronous tool rows (user request).
class BgResultRow {
	private expanded: boolean;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private message: any;
	private theme: any;

	constructor(message: any, theme: any, expanded = false) {
		this.message = message;
		this.theme = theme;
		this.expanded = expanded;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.cachedLines = undefined;
		}
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	handleMouse(event: { type?: string; button?: string }): { handled: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.setExpanded(!this.expanded);
		return { handled: true };
	}

	render(width: number): string[] {
		if (this.cachedLines === undefined || this.cachedWidth !== width) {
			const theme = this.theme;
			const d = (this.message.details ?? {}) as BgResultDetails;
			const ok = d.exit === "0";
			const icon = theme.fg(ok ? "success" : "error", ok ? "✓" : "✗");
			const badge = theme.inverse(theme.bold(" Background "));
			const cmd =
				`${badge} ${icon} ${theme.fg("toolTitle", theme.bold(`$ ${d.command ?? ""}`))}` +
				theme.fg("dim", ` #${d.jobId ?? "?"} · exit ${d.exit ?? "?"} · ${d.secs ?? "?"}s`);

			if (!this.expanded) {
				this.cachedLines = capLines(cmd, MAX_RESULT_LINES, width, theme);
			} else {
				const lines = [cmd, ""];
				for (const line of (d.tail ?? "").split("\n")) {
					if (line.trim()) lines.push(theme.fg("toolOutput", line));
				}
				if (d.errTail) {
					for (const line of d.errTail.split("\n")) {
						if (line.trim()) lines.push(theme.fg("error", line));
					}
				}
				if (d.outPath) lines.push("", theme.fg("dim", shortenPath(d.outPath)));
				this.cachedLines = new Text(lines.join("\n"), 0, 0).render(width);
			}
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}
}

export default function (pi: ExtensionAPI) {
	// Badge background launches in the transcript (any bash/powershell call).
	registerBackgroundCallBadge(pi);

	// Override bash immediately (exists in every session).
	registerBgTool(pi, "bash", createBashTool(process.cwd()));

	// Housekeeping: remove stale pi-bg-* temp files from past sessions.
	sweepOldJobFiles();

	// Style bg-bash result deliveries like a compact-tools shell row on the
	// purple customMessage background: collapsed = single capped ✓/✗ status line,
	// click or ctrl+o expands to command, output tail, stderr, and the dimmed
	// full-output path. Both states start with the inverted "Background" chip.
	// BgResultRow owns its own expanded state for clicks;
	// the host forwards ctrl+o via setExpanded. Box adds the outputPad
	// left/right padding tinted purple plus one padding line above and below.
	pi.registerMessageRenderer("bg-bash-result", (message, { expanded, outputPad }, theme) => {
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new BgResultRow(message, theme, expanded));
		return box;
	});

	pi.events.on("async-work:providers:v1", (data) => {
		const discovery = data as ProviderDiscovery;
		if (!currentCtx || discovery.sessionFile !== currentCtx.sessionManager.getSessionFile()) return;
		const epoch = sessionEpoch.signal;
		const sessionFile = discovery.sessionFile;
		discovery.add({ source: "shell", claim: (ids, owner) => claimJobs(pi, epoch, sessionFile, ids, owner) });
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!currentSession(ctx) || event.outcome !== "completed" || event.continue ||
			event.context.pendingMessages.length || ctx.hasPendingMessages()) return;
		trimHistory();
		const pending = [...jobs.values()].filter((job) => currentJob(job) &&
			job.outcome && !job.owner && !job.consumed && !job.submitted);
		if (!pending.length) return;
		const entries = pending.map(resultDraft);
		for (const job of pending) job.submitted = true;
		trimHistory();
		return { entries: [...(event.entries ?? []), ...entries], continue: true };
	});

	pi.on("agent_settled", (event, ctx) => {
		trimHistory();
		if (!currentSession(ctx) || (event as { outcome?: string }).outcome !== "completed" || idleFlush !== undefined) return;
		const epoch = sessionEpoch.signal;
		// Notification-only: defer until Pi has left the busy lifecycle. One shot,
		// no polling, and never replay an offer overwritten by a later handler.
		idleFlush = setTimeout(() => {
			idleFlush = undefined;
			if (epoch.aborted || epoch !== sessionEpoch.signal || !currentSession(ctx) ||
				!ctx.isIdle() || ctx.hasPendingMessages()) return;
			for (const job of jobs.values()) pushIfIdle(pi, job);
		}, 0);
	});

	// Pi 1.3 reports session switches through session_start, not session_switch.
	pi.on("session_tree", (_event, ctx) => invalidateSession(ctx));

	// Override powershell only where pi actually provides it (Windows).
	let psRegistered = false;
	pi.on("session_start", async (_event, ctx) => {
		invalidateSession(ctx, true);
		if (psRegistered) return;
		if (pi.getAllTools().some((t) => t.name === "powershell")) {
			psRegistered = true;
			registerBgTool(pi, "powershell", createPowerShellTool(process.cwd()));
		}
	});

	// Teach the conventions once per agent run, on top of the tool descriptions.
	pi.on("before_agent_start", async (event) => {
		const guidelines = event.systemPromptOptions.promptGuidelines;
		if (!guidelines.includes(GUIDELINE)) guidelines.push(GUIDELINE);
		if (!guidelines.includes(CODEMODE_GUIDELINE)) guidelines.push(CODEMODE_GUIDELINE);
	});

	// Stop all completion watchers on shutdown; the detached processes keep running.
	pi.on("session_shutdown", async () => {
		invalidateSession(undefined, true);
		for (const job of jobs.values()) stopWatcher(job);
		// Drain only stops already requested by a user/agent; never stop other jobs on exit.
		await Promise.allSettled([...jobs.values()].flatMap(job => job.stopping ? [job.stopping] : []));
		jobs.clear();
		sweepOldJobFiles();
	});

	// Guard every bash/powershell call (default timeout injection + sleep-wait
	// block) and give codemode scripts a default deadline. Covers model-issued
	// calls and nested calls made by codemode scripts and other tools via
	// ctx.executeTool (nested calls go through tool_call).
	pi.on("tool_call", async (event) => {
		const input = event.input as (ShellToolInput & { code?: unknown }) | undefined;
		if (!input || typeof input !== "object") return;
		if (event.toolName === "bash" || event.toolName === "powershell") {
			injectShellTimeout(input);
			if (typeof input.command === "string" && input.background !== true && isWaitForSleep(event.toolName, input.command)) {
				return {
					block: true,
					reason:
						`Sleep-waiting wastes the whole turn: run the long command with background:true (you get a job id immediately) ` +
						`and end your turn or keep working - the result is delivered to you automatically when the job finishes. ` +
						`Use wait with explicit job references when blocked; do independent work after dispatch.`,
				};
			}
		} else if (event.toolName === "codemode") {
			injectCodemodeTimeout(input);
		}
	});

	pi.registerCommand("bg", {
		description: "Manage background jobs: Enter views output; s stops gracefully; x force kills (confirmed)",
		handler: async (_args, ctx) => {
			const epoch = sessionEpoch.signal;
			await showJobPanel(ctx, {
				list: () => currentSession(ctx) ? visibleJobs() : [],
				output: id => {
					const job = jobs.get(id);
					if (!job || !currentJob(job)) return "Job is no longer available.";
					return readTail(job.outPath) + (job.errPath ? `\n--- stderr ---\n${readTail(job.errPath, 500, 16 * 1024)}` : "");
				},
				stop: (id, mode) => {
					const job = jobs.get(id);
					if (!job) return Promise.reject(new Error("Job is no longer available"));
					return stopJob(pi, job, "user", mode);
				},
			}, epoch);
		},
	});
}
