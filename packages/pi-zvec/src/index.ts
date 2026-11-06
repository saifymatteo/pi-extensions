// zvec — Zvec-Grep adapter for pi
//
// Independent pi extension: gives the main agent exact, lexical, and semantic
// search over a workspace's code and documents through the `zg` CLI
// (npm i -g @zvec/zvec-grep; CLI docs: https://zvec.org/en/docs/zvec-grep/).
//
// This file is self-contained on purpose: it never references, imports, or
// coordinates with any other extension. Routing is expressed only through this
// tool's own description/promptGuidelines.
//
// Provides:
//   - zvec_search tool : one tool, routed by a `mode` argument:
//                        exact  → zg query --rg   (managed ripgrep; no index/model)
//                        fts    → BM25 lexical ranking
//                        vector → semantic-only
//                        hybrid/auto → positional hybrid query
//   - /zvec-init /zvec-sync /zvec-status
//   - session_start : non-blocking CLI check (report once if missing), config setup,
//                     index discovery by walking up from cwd for .zvec-grep/,
//                     startup sync when indexed, auto-index when not (bounded
//                     by home dir / filesystem root)
//   - agent_settled : single-flight incremental `zg index` after each completed
//                     turn (at most one queued trailing sync)
//   - Footer status : "Zvec: init | sync | synced HH:MM | failed" — empty when inactive
//   - Errors        : background init/sync notify only after retries are exhausted;
//                     manual errors and missing CLI notify immediately. Never saved
//                     to session history or added to model context
//   - Retries       : background init/sync retries after 5s, 15s, 30s; then
//                     paused until a successful manual init/sync or new session
//   - Usage log     : one TSV line per search in <agent-home>/zvec-usage.log
//
// Config (merged, later wins):
//   1. Global : $PI_CODING_AGENT_DIR/extensions/zvec.json (fallback ~/.pi/agent/extensions/zvec.json)
//               — auto-created with defaults when missing.
//   2. Project: <project-root>/.pi/zvec.json — optional per-project overrides.
//   Keys: { "autoInit": boolean, "syncOnSettle": boolean, "embedding": string }
//   Edits are picked up on /reload or the next session start.
//
// Failure detection: non-zero exit, timeout, or output matching FAILURE_RE —
// exit codes are the primary signal and text matching is defensive. The
// success summary contains a literal "0 failed" counter, so per-file failure
// counts are stripped before testing; otherwise every successful index reads
// as a failure.
//
// Notes:
//   - Background ops (auto-index, startup sync, settle sync) only spawn when
//     ctx.hasUI (TUI/RPC). In print/JSON mode pi can exit mid-write. Config
//     setup and command-driven ops still happen in all modes.
//   - The startup sync targets the index owner found by walking up from cwd,
//     not cwd itself, so subdirectories of an indexed repo sync the right index.
//   - Auto-index is skipped when cwd IS the home dir or a filesystem root.
//   - No MCP, no daemon: every call shells out to `zg`, which runs in-process
//     in its default `auto` mode (uses a server only if one is already running).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const INSTALL_HINT = "zg CLI not found on PATH. Install: npm i -g @zvec/zvec-grep";

const STATUS_KEY = "zvec";
const CLI_CHECK_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const SEARCH_TIMEOUT_MS = 120_000;
const SYNC_TIMEOUT_MS = 30 * 60_000; // incremental index can still be large on first catch-up
const INIT_TIMEOUT_MS = 30 * 60_000; // first index downloads the embedding model
const STATUS_TIMEOUT_MS = 30_000;
const FAILURE_RE = /✗|not initialized|no index|no such index|failed/i;
const FAILED_COUNT_RE = /\b0\s+failed\b/gi;

// zg's success summary ends with e.g. "0 failed"; a bare /failed/ match would
// flag every successful run. Drop only the zero counter (a nonzero "N failed"
// is a real failure and must survive). Exported for testing.
export function hasFailureText(out: string): boolean {
	return FAILURE_RE.test(out.replace(FAILED_COUNT_RE, ""));
}
const NO_INDEX_RE = /not initialized|no index|no such index/i;

export type SearchMode = "auto" | "hybrid" | "fts" | "vector" | "exact";

export interface SearchParams {
	query: string;
	mode?: SearchMode;
	path?: string;
	globs?: string[];
	fileTypes?: string[];
	limit?: number;
}

interface ZvecConfig {
	autoInit: boolean;
	syncOnSettle: boolean;
	embedding: string;
}

interface ProjectState {
	config: ZvecConfig;
	projectRoot: string;
	indexed: boolean;
}

const DEFAULT_EMBEDDING = "local/potion-code-16m-v2";
const DEFAULTS: ZvecConfig = {
	autoInit: true,
	syncOnSettle: true,
	embedding: DEFAULT_EMBEDDING,
};

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
// Aborted on session_shutdown (/reload, /new, /resume, /fork): kills in-flight
// zg children so a replaced runtime never leaves an indexer holding zg's lock,
// and tells awaiting command handlers their ctx/pi are now stale.
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

function agentHome(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

function globalConfigPath(): string {
	return path.join(agentHome(), "extensions", "zvec.json");
}

function usageLogPath(): string {
	return path.join(agentHome(), "zvec-usage.log");
}

async function readConfigFile(p: string): Promise<Partial<ZvecConfig>> {
	try {
		const parsed = JSON.parse(await readFile(p, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Partial<ZvecConfig>;
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

// zg does not write a .gitignore inside its index dir (CodeGraph does for
// .codegraph/), so create one — otherwise every indexed repo shows index noise
// in `git status`.
async function ensureIndexGitignore(root: string): Promise<void> {
	const p = path.join(root, ".zvec-grep", ".gitignore");
	if (existsSync(p)) return;
	try {
		await mkdir(path.dirname(p), { recursive: true });
		await writeFile(p, "*\n", "utf8");
	} catch {
		/* repo may be read-only; never break a session over this */
	}
}

// Per-key override, only when the value is a proper type.
function boolOr(project: Partial<ZvecConfig>, global: Partial<ZvecConfig>, key: "autoInit" | "syncOnSettle"): boolean {
	if (typeof project[key] === "boolean") return project[key] as boolean;
	if (typeof global[key] === "boolean") return global[key] as boolean;
	return DEFAULTS[key];
}

function embeddingOr(project: Partial<ZvecConfig>, global: Partial<ZvecConfig>): string {
	if (typeof project.embedding === "string" && project.embedding.trim()) return project.embedding.trim();
	if (typeof global.embedding === "string" && global.embedding.trim()) return global.embedding.trim();
	return DEFAULTS.embedding;
}

// Walk up from startDir looking for .zvec-grep/. Returns the dir owning the
// index. Stops BEFORE home: ~/.zvec-grep is zg's global state dir
// (ZVEC_GREP_HOME: config, locks, auth), not a workspace index — treating it
// as one indexes all of ~ and dies on TCC-protected ~/Library files.
function findIndexRoot(startDir: string): string | null {
	let dir = realSafe(startDir);
	const home = realSafe(homedir());
	for (;;) {
		if (norm(dir) === norm(home)) return null;
		if (existsSync(path.join(dir, ".zvec-grep"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null; // filesystem root checked, stop
		dir = parent;
	}
}

// True when cwd IS the home dir or a filesystem root (auto-index guard).
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

// On Windows `zg` is a `.cmd` shim. Reparsing the command line through cmd.exe
// (and again through the shim's `%*`) misinterprets shell metacharacters, so a
// regex like `a|b` becomes a pipe and the query is destroyed. Resolve the
// package's JS entry once and drive it with `node` directly: no shell involved,
// every argument preserved verbatim.
let zgJsEntry: string | null | undefined;
async function resolveZgJsEntry(pi: ExtensionAPI, signal?: AbortSignal): Promise<string | null> {
	signal?.throwIfAborted();
	if (zgJsEntry !== undefined) return zgJsEntry;
	try {
		const result = await pi.exec("cmd.exe", ["/d", "/s", "/c", "npm", "root", "-g"], {
			timeout: CLI_CHECK_TIMEOUT_MS,
			signal,
		});
		signal?.throwIfAborted();
		const entry = path.join(result.stdout.trim(), "@zvec", "zvec-grep", "dist", "cli", "index.js");
		zgJsEntry = result.code === 0 && !result.killed && existsSync(entry) ? entry : null;
	} catch {
		// Cancellation is not a missing installation and must not poison the cache.
		signal?.throwIfAborted();
		zgJsEntry = null;
	}
	return zgJsEntry;
}

async function execZg(
	pi: ExtensionAPI,
	args: string[],
	options: { signal?: AbortSignal; timeout?: number; cwd?: string } = {},
) {
	if (process.platform === "win32") {
		const entry = await resolveZgJsEntry(pi, options.signal);
		if (entry) {
			try {
				return await pi.exec("node", [entry, ...args], options);
			} catch {
				options.signal?.throwIfAborted();
				/* node missing from PATH: fall back to the shim below */
			}
		}
		// Fallback only: the cmd shim re-parses the command line, so arguments
		// containing shell metacharacters (`|`, `&`, `<`, `>`, `%`, `^`) are not
		// safe here. The node-entry path above exists precisely to avoid this.
		return await pi.exec("cmd.exe", ["/d", "/s", "/c", "zg", ...args], options);
	}
	return await pi.exec("zg", args, options);
}

// Build the zg argv for one search. Pure so it can be unit-tested.
export function buildSearchArgs(p: SearchParams): string[] {
	const mode: SearchMode = p.mode ?? "auto";
	if (mode === "exact") {
		// Managed ripgrep: no index and no embedding model required.
		const args = ["query", "--rg", "-n", p.query];
		for (const g of p.globs ?? []) args.push("-g", g);
		for (const t of p.fileTypes ?? []) args.push("-t", t);
		return args;
	}
	const args = ["query"];
	if (mode === "fts") args.push("--fts", p.query);
	else if (mode === "vector") args.push("--vector", p.query);
	else args.push(p.query); // auto/hybrid: positional query = hybrid
	if (typeof p.limit === "number" && p.limit > 0) args.push("--limit", String(p.limit));
	for (const g of p.globs ?? []) args.push("-g", g);
	for (const t of p.fileTypes ?? []) args.push("-t", t);
	return args;
}

// Pull the freshness label and hit count out of zg's compact output.
export function summarizeOutput(out: string): { hits: number; fresh: "fresh" | "possibly_stale" | "unknown" } {
	const fresh: "fresh" | "possibly_stale" | "unknown" = /freshness:\s*possibly_stale/i.test(out)
		? "possibly_stale"
		: /freshness:\s*fresh/i.test(out)
			? "fresh"
			: "unknown";
	// Indexed output prints `hits: N`; managed rg prints `path` then per-line
	// matches, so fall back to counting those when no summary line is present.
	const summary = out.match(/^hits:\s*(\d+)/m);
	const hits = summary
		? Number(summary[1])
		: (out.match(/^(?:[^\s:]+:\d+|\s*\d+[:-])/gm) ?? []).length;
	return { hits, fresh };
}

function sanitizeField(v: string): string {
	return v.replace(/[\t\r\n]+/g, " ").slice(0, 300);
}

export function formatUsageLine(entry: {
	iso: string;
	sessionId: string;
	cwd: string;
	mode: string;
	query: string;
	hits: number;
	ms: number;
	fresh: string;
	code: number;
}): string {
	return [
		entry.iso,
		sanitizeField(entry.sessionId),
		sanitizeField(entry.cwd),
		entry.mode,
		sanitizeField(entry.query),
		String(entry.hits),
		String(entry.ms),
		entry.fresh,
		`exit=${entry.code}`,
	].join("\t");
}

function logUsage(line: string): void {
	try {
		appendFileSync(usageLogPath(), `${line}\n`);
	} catch {
		/* never break a search over logging */
	}
}

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		const sm = (ctx as unknown as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
		return sm?.getSessionId?.() ?? "";
	} catch {
		return "";
	}
}

export default function zvec(pi: ExtensionAPI) {
	let initialization: Promise<void> | null = null;
	let cliCheck: Promise<boolean> | null = null;

	// Share a cancellable probe across startup and concurrent first calls.
	async function ensureCli(pi2: ExtensionAPI): Promise<boolean> {
		if (cliAvailable !== null) return cliAvailable;
		const gen = sessionGen;
		const signal = runtimeAbort.signal;
		cliCheck ??= (async () => {
			try {
				const r = await execZg(pi2, ["version"], { timeout: CLI_CHECK_TIMEOUT_MS, signal });
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
	function spawnOp(kind: "init" | "sync", ctx: ExtensionContext, gen: number, target: string, attempt = 0) {
		const token = ++opSeq;
		currentOpToken = token;
		const embedding = state?.config.embedding ?? DEFAULT_EMBEDDING;
		const args = kind === "init" ? ["index", target, "--embedding", embedding] : ["index", target];
		const timeout = kind === "init" ? INIT_TIMEOUT_MS : SYNC_TIMEOUT_MS;
		status(ctx, gen, kind === "init" ? "Zvec: init" : "Zvec: sync");

		void (async () => {
			const started = Date.now();
			let failure: string | null = null;
			let detail = "";
			try {
				const r = await execZg(pi, args, { timeout, cwd: target, signal: runtimeAbort.signal });
				const out = combined(r);
				if (r.killed) {
					failure = `Zvec ${kind} timed out (${Math.round(timeout / 60_000)}m)`;
					detail = out;
				} else if (r.code !== 0 || hasFailureText(out)) {
					failure = `Zvec ${kind} failed (exit ${r.code})`;
					detail = out || "(no output)";
				}
			} catch (err) {
				failure = `Zvec ${kind} failed`;
				detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
			}

			if (gen !== sessionGen || currentOpToken !== token) return;
			const secs = Math.round((Date.now() - started) / 1000);
			if (failure) {
				const delay = RETRY_DELAYS_MS[attempt];
				if (delay !== undefined) {
					status(ctx, gen, `Zvec: retry ${attempt + 1}/3 in ${delay / 1000}s`);
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
				status(ctx, gen, "Zvec: failed");
			} else {
				if (state && norm(state.projectRoot) === norm(target)) {
					state.indexed = true;
				}
				if (kind === "init") await ensureIndexGitignore(target);
				if (gen !== sessionGen) return;
				status(ctx, gen, kind === "init" ? `Zvec: indexed in ${secs}s` : `Zvec: synced ${hhmm()}`);
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

	// ── zvec_search tool ───────────────────────────────────────────────────
	pi.registerTool({
		name: "zvec_search",
		label: "Zvec Search",
		description:
			"Searches workspace code and text, returning compact, source-linked evidence: exact literal/regex " +
			"(managed ripgrep), BM25 keyword ranking, and semantic/vector + hybrid retrieval.",
		promptSnippet:
			"Exact, ranked, and semantic workspace search (mode: auto|hybrid|fts|vector|exact)",
		promptGuidelines: [
			"Use zvec_search when the wording or location is unknown (semantic/hybrid), to rank known terms (fts), or for an exact literal or regex (mode:'exact').",
			"The workspace index auto-builds and auto-syncs; /zvec-init forces a rebuild. mode:'exact' runs without the index.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "The search text: a natural-language question, keywords, or (mode:'exact') a literal/regex",
			}),
			mode: Type.Optional(
				Type.Union(
					[
						Type.Literal("auto"),
						Type.Literal("hybrid"),
						Type.Literal("fts"),
						Type.Literal("vector"),
						Type.Literal("exact"),
					],
					{
						description:
							"auto/hybrid = lexical+semantic fusion (default); fts = BM25 keyword ranking; vector = semantic only; exact = managed ripgrep (literal/regex, no index)",
					},
				),
			),
			path: Type.Optional(
				Type.String({ description: "Workspace root to search; defaults to the nearest indexed root from cwd" }),
			),
			globs: Type.Optional(
				Type.Array(Type.String(), { description: "Include/exclude path globs (prefix ! to exclude)" }),
			),
			fileTypes: Type.Optional(Type.Array(Type.String(), { description: "File-type filters, e.g. ['ts']" })),
			limit: Type.Optional(Type.Integer({ description: "Maximum results per group" })),
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
			const root = params.path ? path.resolve(params.path) : (findIndexRoot(ctx.cwd) ?? ctx.cwd);
			const mode: SearchMode = params.mode ?? "auto";
			const args = buildSearchArgs({
				query: params.query,
				mode,
				path: params.path,
				globs: params.globs,
				fileTypes: params.fileTypes,
				limit: params.limit,
			});
			const started = Date.now();
			let result: Awaited<ReturnType<typeof execZg>>;
			try {
				result = await execZg(pi, args, { signal, timeout: SEARCH_TIMEOUT_MS, cwd: root });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err));
			}
			const ms = Date.now() - started;
			const out = result.stdout.trim() || combined(result) || `exit ${result.code}`;
			const { hits, fresh } = summarizeOutput(out);
			logUsage(
				formatUsageLine({
					iso: new Date().toISOString(),
					sessionId: sessionIdOf(ctx),
					cwd: root,
					mode,
					query: params.query,
					hits,
					ms,
					fresh,
					code: result.code,
				}),
			);
			if (result.killed) return textResult("zvec search timed out (120s)");
			if (result.code !== 0) {
				const failOut = outputOf(result);
				if (mode !== "exact" && NO_INDEX_RE.test(failOut)) {
					return textResult(
						`${failOut}\n\nThis workspace has no Zvec index yet. Build one with /zvec-init ` +
							`(or run: zg index "${root}"), or use mode:'exact' for index-free search.`,
					);
				}
				return textResult(failOut);
			}
			return textResult(out);
		},
	});

	// Command exceptions use the same non-persistent notification as CLI failures.
	function registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
		pi.registerCommand(name, {
			...command,
			handler: async (args, ctx) => {
				const gen = sessionGen;
				const indexes = name === "zvec-init" || name === "zvec-sync";
				// A manual operation can replace a delayed retry, not a live writer.
				if (indexes && currentOpToken !== 0 && retryTimer === null) {
					if (ctx.hasUI) ctx.ui.notify(`Zvec: indexing already in progress. Try /${name} again when it finishes.`, "info");
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
					reportError(ctx, gen, `Zvec command /${name} failed`, err instanceof Error ? (err.stack ?? err.message) : String(err));
				} finally {
					if (token && gen === sessionGen && currentOpToken === token) {
						currentOpToken = 0;
						maybeTrailing();
					}
				}
			},
		});
	}

	// ── /zvec-init ─────────────────────────────────────────────────────────
	registerCommand("zvec-init", {
		description: "Build the Zvec index for the current project (zg index)",
		handler: async (args, ctx) => {
			const sig = runtimeAbort.signal;
			const target = args?.trim() || ctx.cwd;
			if (!(await ensureCli(pi))) {
				if (!sig.aborted) reportError(ctx, sessionGen, INSTALL_HINT);
				return;
			}
			if (sig.aborted) return;
			const embedding = state?.config.embedding ?? DEFAULT_EMBEDDING;
			if (ctx.hasUI) {
				ctx.ui.notify(`Indexing ${target} with ${embedding} — first run downloads the model…`, "info");
			}
			const result = await execZg(pi, ["index", target, "--embedding", embedding], {
				timeout: INIT_TIMEOUT_MS,
				cwd: target,
				signal: sig,
			});
			if (sig.aborted) return; // reloaded mid-run: ctx and pi are stale
			const out = outputOf(result);
			const success = !result.killed && result.code === 0 && !hasFailureText(out);
			if (success) retriesExhausted = false;
			if (success && state) {
				state.projectRoot = target;
				state.indexed = true;
			}
			if (success) await ensureIndexGitignore(target);
			if (sig.aborted) return;
			if (!success) {
				reportError(ctx, sessionGen, result.killed ? "Zvec init timed out" : `Zvec init failed (exit ${result.code})`, out);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify("Zvec index built.", "info");
			pi.sendMessage({ customType: "zvec-init", content: out, display: true }, { triggerTurn: false });
		},
	});

	// ── /zvec-sync ─────────────────────────────────────────────────────────
	registerCommand("zvec-sync", {
		description: "Update the Zvec index for new/changed files (zg index)",
		handler: async (args, ctx) => {
			const sig = runtimeAbort.signal;
			const target = args?.trim() || state?.projectRoot || ctx.cwd;
			if (!(await ensureCli(pi))) {
				if (!sig.aborted) reportError(ctx, sessionGen, INSTALL_HINT);
				return;
			}
			if (sig.aborted) return;
			if (ctx.hasUI) ctx.ui.notify(`Syncing Zvec for ${target}…`, "info");
			const result = await execZg(pi, ["index", target], { timeout: SYNC_TIMEOUT_MS, cwd: target, signal: sig });
			if (sig.aborted) return; // reloaded mid-run: ctx and pi are stale
			const out = outputOf(result);
			const success = !result.killed && result.code === 0 && !hasFailureText(out);
			if (success) retriesExhausted = false;
			if (success && state) state.indexed = true;
			if (!success) {
				reportError(ctx, sessionGen, result.killed ? "Zvec sync timed out" : `Zvec sync failed (exit ${result.code})`, out);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify("Zvec synced.", "info");
			pi.sendMessage({ customType: "zvec-sync", content: out, display: true }, { triggerTurn: false });
		},
	});

	// ── /zvec-status ───────────────────────────────────────────────────────
	registerCommand("zvec-status", {
		description: "Show Zvec index status and statistics",
		handler: async (args, ctx) => {
			const sig = runtimeAbort.signal;
			const target = args?.trim() || state?.projectRoot || ctx.cwd;
			if (!(await ensureCli(pi))) {
				if (!sig.aborted) reportError(ctx, sessionGen, INSTALL_HINT);
				return;
			}
			if (sig.aborted) return;
			const result = await execZg(pi, ["status", target], { timeout: STATUS_TIMEOUT_MS, signal: sig });
			if (sig.aborted) return; // reloaded mid-run: ctx and pi are stale
			const out = outputOf(result);
			if (result.code !== 0 || result.killed || hasFailureText(out)) {
				reportError(ctx, sessionGen, result.killed ? "Zvec status timed out" : `Zvec status failed (exit ${result.code})`, out);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(out, "info");
			pi.sendMessage({ customType: "zvec-status", content: out, display: true }, { triggerTurn: false });
		},
	});

	// ── session_start: CLI check → config → auto-index / startup sync ─────
	// ── session_shutdown: kill in-flight zg children, invalidate UI writes ──
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

		if (gen !== sessionGen || signal.aborted) return;
		await ensureGlobalConfig();
		if (gen !== sessionGen || signal.aborted) return;
		const indexedRoot = findIndexRoot(ctx.cwd);
		const projectRoot = indexedRoot ?? ctx.cwd;
		const [globalCfg, projectCfg] = await Promise.all([
			readConfigFile(globalConfigPath()),
			readConfigFile(path.join(projectRoot, ".pi", "zvec.json")),
		]);
		const config: ZvecConfig = {
			autoInit: boolOr(projectCfg, globalCfg, "autoInit"),
			syncOnSettle: boolOr(projectCfg, globalCfg, "syncOnSettle"),
			embedding: embeddingOr(projectCfg, globalCfg),
		};
		if (gen !== sessionGen || signal.aborted) return;
		state = { config, projectRoot, indexed: indexedRoot !== null };

		// A manual init/sync requested during setup already owns the writer slot.
		if (currentOpToken !== 0) return;
		if (indexedRoot !== null) {
			await ensureIndexGitignore(indexedRoot);
			// Startup sync on the index owner (not cwd — cwd may be a subdir).
			if (gen === sessionGen && !signal.aborted && currentOpToken === 0 && ctx.hasUI) spawnOp("sync", ctx, gen, projectRoot);
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
			if (!signal.aborted) reportError(ctx, gen, "Zvec startup failed", error instanceof Error ? error.message : String(error));
		});
	});

	// ── agent_settled: single-flight incremental index after each turn ────
	pi.on("agent_settled", (_event, ctx) => {
		latestCtx = ctx;
		// Print/JSON mode: pi exits after prompts; a fire-and-forget child
		// could be killed mid-write.
		if (!ctx.hasUI) return;
		if (retriesExhausted || !state?.indexed || !state.config.syncOnSettle) return;
		if (currentOpToken !== 0) {
			pendingSync = true; // at most one trailing sync
			return;
		}
		spawnOp("sync", ctx, sessionGen, state.projectRoot);
	});
}
