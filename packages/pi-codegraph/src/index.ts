// codegraph — CodeGraph adapter for pi
//
// Vendored merge of @izhimu/pi-codegraph 0.3.0 (MIT, https://github.com/izhimu/pi-codegraph)
// and the former local codegraph-auto.ts automation layer. Upstream is itself an
// adapter for the codegraph CLI (npm i -g @colbymchenry/codegraph; CLI source and
// command surface: https://github.com/colbymchenry/codegraph — see
// research/codegraph-cli.md in this repo for the researched CLI contract).
//
// REMOVE @izhimu/pi-codegraph before using this file: it registers the same
// tool and commands, and a duplicate registration is at best noise.
//
// Provides:
//   - codegraph_explore tool : symbol source + call paths from the .codegraph/ index
//   - /codegraph-init /codegraph-sync /codegraph-status /codegraph-unlock
//   - session_start : non-blocking CLI check (report once if missing), config setup, auto-init
//                     when no index is found walking up from cwd (bounded by home
//                     dir / filesystem root), and startup sync when indexed
//   - agent_settled : single-flight sync after each completed turn (at most one
//                     queued trailing sync)
//   - Footer status : "CodeGraph: init | sync | synced HH:MM | failed" — empty
//                     whenever inactive
//   - Errors        : background init/sync notify only after retries are exhausted;
//                     manual errors and missing CLI notify immediately. Never saved
//                     to session history or added to model context
//   - Retries       : background init/sync retries after 5s, 15s, 30s; then
//                     paused until a successful manual init/sync or new session
//
// Config (merged, later wins; both default true):
//   1. Global : $PI_CODING_AGENT_DIR/extensions/codegraph.json (fallback ~/.pi/agent/extensions/codegraph.json)
//               — auto-created with defaults when missing.
//   2. Project: <project-root>/.pi/codegraph.json — opt-in per-project overrides.
//   Keys: { "autoInit": boolean, "syncOnSettle": boolean }
//   Edits are picked up on /reload or the next session start.
//
// Failure detection: non-zero exit, timeout, or output matching
// /✗|not initialized|stale lock|already locked|lock file/ — research says all
// CLI failures exit 1 (research/codegraph-cli.md §2), so exit codes are the
// primary signal and text matching is defensive belt-and-braces; the fs
// walk-up check (.codegraph/codegraph.db) decides indexing state.
//
// Notes:
//   - Background ops (auto-init, startup sync, settle sync) only spawn when
//     ctx.hasUI (TUI/RPC). In print/JSON mode pi can exit mid-write and leave
//     a stale lock (that is what /codegraph-unlock is for). Config setup and
//     command-driven ops still happen in all modes.
//   - The startup sync targets the index owner found by walking up from cwd,
//     not cwd itself, so subdirectories of an indexed repo sync the right db.
//   - Auto-init is skipped when cwd IS the home dir or a filesystem root
//     (mirrors the CLI's own guard). Sync is allowed even if the index lives
//     in the home dir; disable via config if unwanted.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const INSTALL_HINT =
	"codegraph CLI not found on PATH. Install: npm i -g @colbymchenry/codegraph";

const STATUS_KEY = "codegraph";
const CLI_CHECK_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const EXPLORE_TIMEOUT_MS = 120_000;
const SYNC_TIMEOUT_MS = 5 * 60_000; // matches /codegraph-sync
const INIT_TIMEOUT_MS = 30 * 60_000; // matches /codegraph-init
const STATUS_TIMEOUT_MS = 30_000;
const UNLOCK_TIMEOUT_MS = 10_000;
const FAILURE_RE = /✗|not initialized|stale lock|already locked|lock file/i;

interface CgConfig {
	autoInit: boolean;
	syncOnSettle: boolean;
}

interface ProjectState {
	config: CgConfig;
	projectRoot: string;
	indexed: boolean;
}

const DEFAULTS: CgConfig = { autoInit: true, syncOnSettle: true };

// Session-scoped module state. The factory re-runs (same module object) when
// pi rebinds extensions for /new, /resume, /fork and /reload, so a generation
// token invalidates UI writes from ops belonging to a replaced session.
let sessionGen = 0;
let opSeq = 0;
let currentOpToken = 0; // 0 = idle
let pendingSync = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retriesExhausted = false;
let state: ProjectState | null = null;
let latestCtx: ExtensionContext | null = null;
let cliAvailable: boolean | null = null;
let notifiedMissing = false;
let runtimeAbort = new AbortController();

function norm(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

function realSafe(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function globalConfigPath(): string {
	const dir =
		process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
	return path.join(dir, "extensions", "codegraph.json");
}

async function readConfigFile(p: string): Promise<Partial<CgConfig>> {
	try {
		const parsed = JSON.parse(await readFile(p, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Partial<CgConfig>;
		}
	} catch {
		// missing or invalid file → treated as {}
	}
	return {};
}

async function ensureGlobalConfig(): Promise<void> {
	const p = globalConfigPath();
	if (existsSync(p)) return;
	try {
		await mkdir(path.dirname(p), { recursive: true });
		await writeFile(p, `${JSON.stringify(DEFAULTS, null, 2)}\n`, "utf8");
	} catch {
		// read-only dir etc. → defaults stay in memory only
	}
}

// Per-key override, only when the value is a proper boolean.
function boolOr(
	project: Partial<CgConfig>,
	global: Partial<CgConfig>,
	key: keyof CgConfig,
): boolean {
	if (typeof project[key] === "boolean") return project[key] as boolean;
	if (typeof global[key] === "boolean") return global[key] as boolean;
	return DEFAULTS[key];
}

// Walk up from startDir looking for .codegraph/codegraph.db. Checks the home
// dir itself, then stops (nothing above it). Returns the dir owning the index.
function findIndexRoot(startDir: string): string | null {
	let dir = realSafe(startDir);
	const home = realSafe(homedir());
	for (;;) {
		if (existsSync(path.join(dir, ".codegraph", "codegraph.db"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null; // filesystem root checked, stop
		if (norm(dir) === norm(home)) return null; // home checked, stop
		dir = parent;
	}
}

// True when cwd IS the home dir or a filesystem root (CLI's init guard).
function isHomeOrRoot(dir: string): boolean {
	const real = realSafe(dir);
	if (path.dirname(real) === real) return true;
	return norm(real) === norm(realSafe(homedir()));
}

function combined(r: { stdout: string; stderr: string }): string {
	return `${r.stdout}\n${r.stderr}`.trim();
}

function outputOf(result: { stdout: string; stderr: string; code: number }): string {
	return combined(result) || `exit ${result.code}`;
}

function hhmm(): string {
	const d = new Date();
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

async function execCg(
	pi: ExtensionAPI,
	args: string[],
	options: { signal?: AbortSignal; timeout?: number; cwd?: string } = {},
) {
	if (process.platform === "win32") {
		return await pi.exec("cmd.exe", ["/d", "/s", "/c", "codegraph", ...args], options);
	}
	return await pi.exec("codegraph", args, options);
}

export default function codegraph(pi: ExtensionAPI) {
	let initialization: Promise<void> | null = null;
	let cliCheck: Promise<boolean> | null = null;

	// Share a cancellable probe across startup and concurrent first calls.
	async function ensureCli(pi2: ExtensionAPI): Promise<boolean> {
		if (cliAvailable !== null) return cliAvailable;
		const gen = sessionGen;
		const signal = runtimeAbort.signal;
		cliCheck ??= (async () => {
			try {
				const r = await execCg(pi2, ["version"], { timeout: CLI_CHECK_TIMEOUT_MS, signal });
				if (gen !== sessionGen || signal.aborted) return false;
				cliAvailable = r.code === 0 && !r.killed;
			} catch {
				if (gen !== sessionGen || signal.aborted) return false;
				cliAvailable = false;
			}
			return cliAvailable === true;
		})();
		return cliCheck;
	}

	// ── UI helpers: drop writes from a replaced session, never crash pi ───
	function status(ctx: ExtensionContext, gen: number, text: string | undefined) {
		if (gen !== sessionGen) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			/* replaced session */
		}
	}

	function reportError(ctx: ExtensionContext, gen: number, title: string, detail = "") {
		if (gen !== sessionGen || !ctx.hasUI) return;
		try {
			ctx.ui.notify(detail ? `${title}\n${detail}` : title, "error");
		} catch {
			/* replaced session */
		}
	}

	// A waiting retry owns the single-flight slot, just like a running child.
	function cancelRetry() {
		if (retryTimer === null) return;
		clearTimeout(retryTimer);
		retryTimer = null;
		currentOpToken = 0;
		pendingSync = false;
	}

	// ── background ops (init/sync): bounded retries + trailing sync ─────────
	// Spawn init/sync, report outcome, then run a queued trailing sync if any.
	function spawnOp(kind: "init" | "sync", ctx: ExtensionContext, gen: number, target: string, attempt = 0) {
		const token = ++opSeq;
		currentOpToken = token;
		const args =
			kind === "init"
				? ["--no-color", "init", "-y", target]
				: ["--no-color", "sync", "-q", target];
		const timeout = kind === "init" ? INIT_TIMEOUT_MS : SYNC_TIMEOUT_MS;
		status(ctx, gen, kind === "init" ? "CodeGraph: init" : "CodeGraph: sync");

		void (async () => {
			let failure: string | null = null;
			let detail = "";
			try {
				const r = await execCg(pi, args, { timeout, cwd: target, signal: runtimeAbort.signal });
				const out = combined(r);
				if (r.killed) {
					failure = `CodeGraph ${kind} timed out (${Math.round(timeout / 60_000)}m)`;
					detail = out;
				} else if (r.code !== 0 || FAILURE_RE.test(out)) {
					failure = `CodeGraph ${kind} failed (exit ${r.code})`;
					detail = out || "(no output)";
				}
			} catch (err) {
				failure = `CodeGraph ${kind} failed`;
				detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
			}

			if (gen !== sessionGen || currentOpToken !== token) return;
			if (failure) {
				const delay = RETRY_DELAYS_MS[attempt];
				if (delay !== undefined) {
					status(ctx, gen, `CodeGraph: retry ${attempt + 1}/3 in ${delay / 1000}s`);
					retryTimer = setTimeout(() => {
						if (gen !== sessionGen || currentOpToken !== token) return;
						retryTimer = null;
						spawnOp(kind, ctx, gen, target, attempt + 1);
					}, delay);
					return;
				}
				// Recovered retries leave no notification; report only the final failure.
				reportError(ctx, gen, failure, detail);
				retriesExhausted = true;
				pendingSync = false;
				status(ctx, gen, "CodeGraph: failed");
			} else {
				// A successful init or sync of the tracked project root means the
				// index exists — settle syncs may proceed.
				if (state && norm(state.projectRoot) === norm(target)) {
					state.indexed = true;
				}
				status(ctx, gen, `CodeGraph: synced ${hhmm()}`);
			}
			if (currentOpToken === token) currentOpToken = 0;
			maybeTrailing();
		})();
	}

	function maybeTrailing() {
		if (!pendingSync || currentOpToken !== 0) return;
		pendingSync = false;
		if (retriesExhausted || !state?.indexed || !state.config.syncOnSettle || !latestCtx) return;
		spawnOp("sync", latestCtx, sessionGen, state.projectRoot);
	}

	// ── codegraph_explore tool ─────────────────────────────────────────────
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"Structural code queries against the project's CodeGraph index: the relevant symbols' verbatim " +
			"line-numbered source and the call paths between them.",
		promptSnippet:
			"Symbol source + call paths from the project's CodeGraph index",
		promptGuidelines: [
			"Use codegraph_explore for structural questions: who calls a symbol, what it calls, what a symbol depends on, the call path between two symbols, or the blast radius of a change.",
			"The index auto-initializes and auto-syncs; /codegraph-init forces a full rebuild.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Symbol names or a natural-language question about the code",
			}),
			path: Type.Optional(
				Type.String({
					description: "Project path to query; defaults to the current working directory",
				}),
			),
			maxFiles: Type.Optional(
				Type.Integer({
					description: "Maximum number of files to include source from",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const lifecycle = runtimeAbort.signal;
			await initialization;
			lifecycle.throwIfAborted();
			signal?.throwIfAborted();
			const available = await ensureCli(pi);
			lifecycle.throwIfAborted();
			signal?.throwIfAborted();
			if (!available) return textResult(INSTALL_HINT);
			const cwd = params.path ?? ctx.cwd;
			const args = ["explore", params.query, "-p", cwd];
			if (typeof params.maxFiles === "number" && params.maxFiles > 0) {
				args.push("--max-files", String(params.maxFiles));
			}
			const result = await execCg(pi, args, { signal, timeout: EXPLORE_TIMEOUT_MS });
			if (result.killed) return textResult("codegraph explore timed out (120s)");
			// Non-zero exits carry upstream's agent-friendly guidance (e.g. the
			// "not initialized" message) — pass it through verbatim.
			if (result.code !== 0) return textResult(outputOf(result));
			return textResult(result.stdout.trim());
		},
	});

	// Command exceptions use the same non-persistent notification as CLI failures.
	function registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
		pi.registerCommand(name, {
			...command,
			handler: async (args, ctx) => {
				const gen = sessionGen;
				const indexes = name === "codegraph-init" || name === "codegraph-sync";
				// A manual operation can replace a delayed retry, not a live writer.
				if (indexes && currentOpToken !== 0 && retryTimer === null) {
					if (ctx.hasUI) ctx.ui.notify(`CodeGraph: indexing already in progress. Try /${name} again when it finishes.`, "info");
					return;
				}
				if (indexes) cancelRetry();
				const token = indexes ? ++opSeq : 0;
				if (token) currentOpToken = token;
				try {
					await initialization;
					if (gen !== sessionGen || runtimeAbort.signal.aborted) return;
					await command.handler(args, ctx);
				} catch (err) {
					reportError(ctx, gen, `CodeGraph command /${name} failed`, err instanceof Error ? (err.stack ?? err.message) : String(err));
				} finally {
					if (token && gen === sessionGen && currentOpToken === token) {
						currentOpToken = 0;
						maybeTrailing();
					}
				}
			},
		});
	}

	// ── /codegraph-init ────────────────────────────────────────────────────
	registerCommand("codegraph-init", {
		description: "Build the CodeGraph index for the current project (codegraph init)",
		handler: async (args, ctx) => {
			const gen = sessionGen;
			if (!(await ensureCli(pi))) {
				reportError(ctx, gen, INSTALL_HINT);
				return;
			}
			if (gen !== sessionGen) return;
			const target = args?.trim() || ctx.cwd;
			if (ctx.hasUI) {
				ctx.ui.notify(`Indexing ${target} — can take minutes on a large repo…`, "info");
			}
			const result = await execCg(pi, ["--no-color", "init", "-y", target], {
				timeout: INIT_TIMEOUT_MS,
				cwd: target,
			});
			const out = outputOf(result);
			if (gen !== sessionGen) return;
			const success = !result.killed && result.code === 0 && !FAILURE_RE.test(out);
			if (!success) {
				reportError(ctx, gen, result.killed ? "CodeGraph init timed out" : `CodeGraph init failed (exit ${result.code})`, out);
				return;
			}
			retriesExhausted = false;
			if (state) {
				state.projectRoot = target;
				state.indexed = true;
			}
			if (ctx.hasUI) ctx.ui.notify("CodeGraph index built.", "info");
			pi.sendMessage(
				{ customType: "codegraph-init", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /codegraph-sync ────────────────────────────────────────────────────
	registerCommand("codegraph-sync", {
		description: "Sync CodeGraph changes since last index (codegraph sync)",
		handler: async (args, ctx) => {
			const gen = sessionGen;
			if (!(await ensureCli(pi))) {
				reportError(ctx, gen, INSTALL_HINT);
				return;
			}
			if (gen !== sessionGen) return;
			const target = args?.trim() || ctx.cwd;
			if (ctx.hasUI) {
				ctx.ui.notify(`Syncing CodeGraph for ${target}…`, "info");
			}
			const result = await execCg(pi, ["--no-color", "sync", target], {
				timeout: SYNC_TIMEOUT_MS,
				cwd: target,
			});
			const out = outputOf(result);
			if (gen !== sessionGen) return;
			const success = !result.killed && result.code === 0 && !FAILURE_RE.test(out);
			if (!success) {
				reportError(ctx, gen, result.killed ? "CodeGraph sync timed out" : `CodeGraph sync failed (exit ${result.code})`, out);
				return;
			}
			retriesExhausted = false;
			if (state) state.indexed = true;
			if (ctx.hasUI) ctx.ui.notify("CodeGraph synced.", "info");
			pi.sendMessage(
				{ customType: "codegraph-sync", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /codegraph-status ──────────────────────────────────────────────────
	registerCommand("codegraph-status", {
		description: "Show CodeGraph index status and statistics",
		handler: async (args, ctx) => {
			const gen = sessionGen;
			if (!(await ensureCli(pi))) {
				reportError(ctx, gen, INSTALL_HINT);
				return;
			}
			if (gen !== sessionGen) return;
			const target = args?.trim() || ctx.cwd;
			const result = await execCg(pi, ["status", target], { timeout: STATUS_TIMEOUT_MS });
			if (gen !== sessionGen) return;
			const out = outputOf(result);
			if (result.code !== 0 || result.killed || /✗|not initialized/i.test(out)) {
				reportError(ctx, gen, result.killed ? "CodeGraph status timed out" : `CodeGraph status failed (exit ${result.code})`, out);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(out, "info");
			pi.sendMessage(
				{ customType: "codegraph-status", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /codegraph-unlock ──────────────────────────────────────────────────
	registerCommand("codegraph-unlock", {
		description: "Release stale CodeGraph database lock (codegraph unlock)",
		handler: async (args, ctx) => {
			const gen = sessionGen;
			if (!(await ensureCli(pi))) {
				reportError(ctx, gen, INSTALL_HINT);
				return;
			}
			if (gen !== sessionGen) return;
			const target = args?.trim() || ctx.cwd;
			const result = await execCg(pi, ["unlock", target], { timeout: UNLOCK_TIMEOUT_MS });
			if (gen !== sessionGen) return;
			const out = outputOf(result);
			// Successful unlock output can mention the stale lock/lock file it removed.
			if (result.code !== 0 || result.killed || /✗|not initialized/i.test(out)) {
				reportError(ctx, gen, result.killed ? "CodeGraph unlock timed out" : `CodeGraph unlock failed (exit ${result.code})`, out);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(out, "info");
			pi.sendMessage(
				{ customType: "codegraph-unlock", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	pi.on("session_shutdown", async () => {
		cancelRetry();
		runtimeAbort.abort();
		sessionGen++;
		currentOpToken = 0;
		pendingSync = false;
		latestCtx = null;
		const pending = initialization;
		initialization = null;
		cliCheck = null;
		await pending?.catch(() => {});
	});

	// ── session_start: CLI check → config → auto-init / startup sync ──────
	async function initialize(ctx: ExtensionContext, gen: number, signal: AbortSignal) {
		if (gen !== sessionGen || signal.aborted) return;
		if (!(await ensureCli(pi))) {
			if (gen !== sessionGen || signal.aborted) return;
			if (ctx.hasUI && !notifiedMissing) {
				notifiedMissing = true;
				reportError(ctx, gen, INSTALL_HINT);
			}
			return;
		}

		// Config setup happens in every mode; background spawning is TUI/RPC only.
		if (gen !== sessionGen || signal.aborted) return;
		await ensureGlobalConfig();
		if (gen !== sessionGen || signal.aborted) return;
		const indexedRoot = findIndexRoot(ctx.cwd);
		const projectRoot = indexedRoot ?? ctx.cwd;
		const [globalCfg, projectCfg] = await Promise.all([
			readConfigFile(globalConfigPath()),
			readConfigFile(path.join(projectRoot, ".pi", "codegraph.json")),
		]);
		const config: CgConfig = {
			autoInit: boolOr(projectCfg, globalCfg, "autoInit"),
			syncOnSettle: boolOr(projectCfg, globalCfg, "syncOnSettle"),
		};
		if (gen !== sessionGen || signal.aborted) return;
		state = { config, projectRoot, indexed: indexedRoot !== null };

		// A manual init/sync requested during setup already owns the writer slot.
		if (currentOpToken !== 0) return;
		if (indexedRoot !== null) {
			// Startup sync on the index owner (not cwd — cwd may be a subdir).
			if (ctx.hasUI) spawnOp("sync", ctx, gen, projectRoot);
		} else if (config.autoInit && ctx.hasUI && !isHomeOrRoot(ctx.cwd)) {
			spawnOp("init", ctx, gen, ctx.cwd);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		runtimeAbort.abort();
		runtimeAbort = new AbortController();
		const signal = runtimeAbort.signal;
		const gen = ++sessionGen;
		cancelRetry();
		retriesExhausted = false;
		state = null;
		latestCtx = ctx;
		currentOpToken = 0;
		pendingSync = false;
		cliCheck = null;
		status(ctx, gen, undefined);

		// Startup never waits; early tool/command calls share this setup promise.
		initialization = Promise.resolve().then(() => initialize(ctx, gen, signal));
		void initialization.catch((error) => {
			if (!signal.aborted) reportError(ctx, gen, "CodeGraph startup failed", error instanceof Error ? error.message : String(error));
		});
	});

	// ── agent_settled: single-flight sync after each completed turn ────────
	pi.on("agent_settled", (_event, ctx) => {
		latestCtx = ctx;
		// Print/JSON mode: pi exits after prompts; a fire-and-forget child
		// could be killed mid-write and leave a stale lock.
		if (!ctx.hasUI) return;
		if (retriesExhausted || !state?.indexed || !state.config.syncOnSettle) return;
		if (currentOpToken !== 0) {
			pendingSync = true; // at most one trailing sync
			return;
		}
		spawnOp("sync", ctx, sessionGen, state.projectRoot);
	});
}
