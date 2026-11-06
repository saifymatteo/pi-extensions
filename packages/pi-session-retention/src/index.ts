import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { RETENTION_MS, RetentionStore, pathKey, type Guard, type TrashBatch } from "./core.ts";
import { maintenanceGuard } from "./safety.ts";
import type { TrashChoice } from "./dialog.ts";
import { DIALOG_OVERLAY } from "./lib/dialog.ts";

const DAY = 24 * 60 * 60 * 1000;
type State = { approved: boolean; paused: boolean; lastRun: number };
const freshState = (): State => ({ approved: false, paused: false, lastRun: 0 });
const cleanText = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function storePaths(ctx: Pick<ExtensionContext, "sessionManager">, env = process.env) {
	const agent = resolve(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
	const defaults = join(agent, "sessions");
	const actual = resolve(ctx.sessionManager.getSessionDir());
	const cwd = resolve(ctx.sessionManager.getCwd());
	const expected = join(defaults, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	// A custom --session-dir / setting is a flat store. Never broaden it to its parent.
	const explicit = process.argv.some((arg) => arg === "--session-dir" || arg.startsWith("--session-dir="));
	const root = pathKey(actual) === pathKey(expected) && !env.PI_CODING_AGENT_SESSION_DIR && !explicit ? defaults : actual;
	if (dirname(root) === root || pathKey(root).split(/[/\\]/).includes(".trash")) throw new Error("Refusing cleanup of a filesystem root or Trash directory.");
	const key = createHash("sha256").update(pathKey(root)).digest("hex").slice(0, 12);
	return { root, trash: join(dirname(root), ".trash", `${basename(root)}-${key}`) };
}

async function safeDirectory(path: string): Promise<void> {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of relative(current, absolute).split(/[/\\]/).filter(Boolean)) {
		current = join(current, part);
		try { await mkdir(current); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
		const info = await lstat(current);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe retention directory: ${current}`);
	}
}

async function loadState(trash: string): Promise<State> {
	const path = join(trash, "settings.json");
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe retention settings file.");
		const state = JSON.parse(await readFile(path, "utf8"));
		if (typeof state.approved !== "boolean" || typeof state.paused !== "boolean" || !Number.isFinite(state.lastRun) || state.lastRun < 0) throw new Error("Invalid retention settings; no cleanup performed.");
		return state;
	} catch (error: any) { if (error.code === "ENOENT") return freshState(); throw error; }
}

async function saveState(trash: string, state: State) {
	const path = join(trash, `settings-${randomUUID()}.tmp`);
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(JSON.stringify(state));
		await file.sync();
		await file.close();
		await rename(path, join(trash, "settings.json"));
	} finally { await file.close(); await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

async function withLock<T>(trash: string, work: () => Promise<T>): Promise<T> {
	await safeDirectory(trash);
	const path = join(trash, ".maintenance.lock");
	let file;
	try { file = await open(path, "wx", 0o600); }
	catch (error: any) {
		if (error.code !== "EEXIST") throw error;
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe retention lock.");
		const owner = JSON.parse(await readFile(path, "utf8"));
		if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid retention lock; cleanup deferred.");
		try { process.kill(owner.pid, 0); }
		catch (probe: any) {
			if (probe.code !== "ESRCH") throw new Error("Cannot verify retention lock owner; cleanup deferred.");
			throw new Error(`Stale session-maintenance lock: ${path}. Close other Pi processes before removing this lock and retrying.`);
		}
		throw new Error("Session maintenance is already running.");
	}
	try {
		await file.writeFile(JSON.stringify({ pid: process.pid }));
		await file.sync();
		return await work();
	} finally {
		try { await file.close(); } finally { await unlink(path); }
	}
}

// Only invoked by the explicit Trash command; startup scans never read full transcripts.
async function trashSearchText(trash: string, batch: TrashBatch): Promise<{ search: string; title: string }> {
	const values = [batch.manifest.id, ...batch.manifest.files.map((file) => file.original)];
	const labels: string[] = [];
	for (const file of batch.manifest.files) {
		const path = join(trash, batch.manifest.id, file.stored);
		if (batch.missing.includes(file.stored)) continue;
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe Trash file: ${path}`);
		const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
		let name = "", firstPrompt: string | undefined;
		for await (const line of lines) {
			let entry;
			try { entry = JSON.parse(line); } catch { continue; }
			if (!entry || typeof entry !== "object") continue;
			if (entry.type === "session") values.push(entry.id ?? "", entry.cwd ?? "");
			if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
			if (firstPrompt === undefined && entry.type === "message" && entry.message?.role === "user") {
				const content = entry.message.content;
				firstPrompt = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join(" ") : "";
			}
		}
		values.push(name, firstPrompt ?? "");
		labels.push(name || firstPrompt || file.original);
	}
	return { search: cleanText(values.join(" ")), title: cleanText(labels.join(" / ")) };
}

export default function sessionRetention(pi: ExtensionAPI, options: { guard?: () => Promise<void>; now?: () => number } = {}) {
	const now = options.now ?? Date.now;
	let started = false;
	let pendingAutomatic = false;
	let automaticTimer: ReturnType<typeof setTimeout> | undefined;
	let automatic: Promise<void> | undefined;
	let maintaining = false;
	let lifecycle = new AbortController();
	let operation: Promise<unknown> | undefined;
	let closeDialog: (() => void) | undefined;
	function status(ctx: ExtensionContext, text: string | undefined) {
		try { ctx.ui.setStatus("session-retention", text); } catch { /* A replaced UI must not interrupt file safety/lock cleanup. */ }
	}
	async function locked<T>(ctx: ExtensionContext, trash: string, label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const signal = lifecycle.signal;
		signal.throwIfAborted();
		if (maintaining) throw new Error("Session maintenance is already running.");
		maintaining = true;
		try {
			status(ctx, label);
			const running = withLock(trash, async () => { signal.throwIfAborted(); return work(signal); });
			operation = running;
			return await running;
		} finally { operation = undefined; maintaining = false; if (!signal.aborted) status(ctx, undefined); }
	}
	function mutationGuard(ctx: ExtensionContext): Guard {
		const probe = maintenanceGuard(options.guard);
		const signal = lifecycle.signal;
		return async (_operation, paths) => {
			signal.throwIfAborted();
			const active = ctx.sessionManager.getSessionFile();
			if (active && paths.some((path) => pathKey(path) === pathKey(active))) throw new Error("Refusing to move or delete the current session.");
			const allowed = await probe();
			signal.throwIfAborted();
			return allowed;
		};
	}
	const preventSwitch = (_event: unknown, ctx: ExtensionContext) => {
		if (!maintaining) return;
		ctx.ui.notify("Finish or cancel session maintenance before switching sessions.", "warning");
		return { cancel: true };
	};
	pi.on("session_before_switch", preventSwitch);
	pi.on("session_before_fork", preventSwitch);
	function cancelAutomatic() {
		pendingAutomatic = false;
		if (automaticTimer !== undefined) clearTimeout(automaticTimer);
		automaticTimer = undefined;
	}
	pi.on("session_shutdown", async (_event, ctx) => {
		cancelAutomatic();
		status(ctx, undefined);
		lifecycle.abort();
		closeDialog?.();
		// Drain the background handler as well as file work before replacing its context.
		await automatic?.catch(() => {});
		// Never release a lock while a file operation can still be using it.
		await operation?.catch(() => {});
		started = false;
	});

	async function cleanup(ctx: ExtensionContext, manual: boolean, previewOnly = false) {
		if (ctx.mode !== "tui") return;
		const paths = storePaths(ctx);
		await locked(ctx, paths.trash, "Session cleanup: checking schedule…", async (signal) => {
			const state = await loadState(paths.trash);
			signal.throwIfAborted();
			const time = now();
			if (!manual && (state.paused || time - state.lastRun < DAY)) return;
			const store = new RetentionStore(paths.root, paths.trash);
			const current = ctx.sessionManager.getSessionFile();
			status(ctx, "Session cleanup: scanning sessions…");
			const scan = await store.scan({ now: time, protectedPaths: current ? [current] : [] });
			if (scan.aborted) throw new Error(`Session cleanup deferred: ${scan.issues.join("; ")}`);
			signal.throwIfAborted();
			const trash = await store.listTrash();
			signal.throwIfAborted();
			const expired = trash.batches.filter((batch) => batch.manifest.ready && !batch.missing.length && time - batch.manifest.trashedAt > RETENTION_MS);
			if (trash.issues.length) ctx.ui.notify(`Some Trash records were skipped: ${trash.issues.join("; ")}`, "warning");
			const count = scan.candidates.reduce((sum, family) => sum + family.paths.length, 0);
			const summary = [
				`Store: ${paths.root}`,
				`${scan.candidates.length} inactive families (${count} sessions) → Trash for 30 days.`,
				`${expired.length} expired Trash families → permanent deletion.`,
				"A family is eligible only after its newest file has been inactive for 30 days.",
				"Named sessions follow the same rule. The current session's family is protected.",
				"Close other Pi windows and do not launch another process during maintenance.",
				...scan.candidates.slice(0, 8).map((family) => cleanText(`• ${relative(paths.root, family.paths[0])} (${family.paths.length} sessions)`)),
				...(scan.candidates.length > 8 ? [`… and ${scan.candidates.length - 8} more families.`] : []),
			].join("\n");
			if (previewOnly) { status(ctx, "Session cleanup: preview — no changes"); await ctx.ui.confirm("Preview only — nothing will be changed", summary, { signal }); return; }
			if (!state.approved || state.paused) {
				if (!manual) {
					// Background discovery must not replace the editor with an approval dialog.
					if (count || expired.length) ctx.ui.notify("Session cleanup is available. Run /session-cleanup to review and enable daily automatic cleanup.", "info");
					state.lastRun = time;
					await saveState(paths.trash, state);
					return;
				}
				status(ctx, "Session cleanup: awaiting approval…");
				const approved = await ctx.ui.confirm("Enable daily session cleanup?", `${summary}\n\nApprove this cleanup and future automatic cleanup at startup (at most daily)?`, { signal });
				signal.throwIfAborted();
				if (!approved) {
					state.lastRun = time; await saveState(paths.trash, state); return;
				}
				state.approved = true;
				state.paused = false;
			}
			const guard = mutationGuard(ctx);
			status(ctx, "Session cleanup: checking other Pi processes…");
			await guard("trash", []);
			if (scan.candidates.length) {
				status(ctx, `Session cleanup: moving ${count} sessions to Trash…`);
				await store.trashFamilies(scan.candidates, { now: time, guard });
			}
			signal.throwIfAborted();
			status(ctx, "Session cleanup: purging expired Trash…");
			const purged = await store.purgeExpired({ now: time, guard });
			signal.throwIfAborted();
			state.lastRun = time;
			await saveState(paths.trash, state);
			signal.throwIfAborted();
			if (count || purged.purged.length || manual) ctx.ui.notify(`Session cleanup: ${count} sessions moved to Trash; ${purged.purged.length} families permanently deleted. /session-trash restores families.`, "info");
			if (purged.issues.length) ctx.ui.notify(purged.issues.join("; "), "warning");
		});
	}

	function scheduleAutomatic(ctx: ExtensionContext) {
		if (!pendingAutomatic || automaticTimer !== undefined || automatic || maintaining) return;
		const signal = lifecycle.signal;
		if (signal.aborted) return;
		// Yield before starting maintenance; startup never awaits this task.
		automaticTimer = setTimeout(() => {
			automaticTimer = undefined;
			if (signal.aborted || !pendingAutomatic || !ctx.isIdle() || maintaining) return;
			pendingAutomatic = false;
			automatic = cleanup(ctx, false)
				.catch((error) => {
					if (!signal.aborted) {
						try { ctx.ui.notify(message(error), "warning"); } catch { /* UI failures must not reject a detached task. */ }
					}
				})
				.finally(() => { automatic = undefined; });
		}, 0);
		automaticTimer.unref();
	}
	pi.on("session_start", (_event, ctx) => {
		if (lifecycle.signal.aborted) lifecycle = new AbortController();
		if (started || ctx.mode !== "tui" || !ctx.sessionManager.getSessionFile()) return;
		started = true;
		pendingAutomatic = true;
		scheduleAutomatic(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => { scheduleAutomatic(ctx); });

	pi.registerCommand("session-cleanup", {
		description: "Clean inactive session families [preview|pause]",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "preview", label: "preview — inspect without changing sessions" },
				{ value: "pause", label: "pause — disable automatic cleanup" },
			].filter((item) => item.value.startsWith(prefix));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("Session maintenance requires interactive mode.", "warning");
			const signal = lifecycle.signal;
			const action = args.trim();
			if (!["", "preview", "pause"].includes(action)) return ctx.ui.notify("Usage: /session-cleanup [preview|pause]", "info");
			cancelAutomatic();
			try {
				if (action === "pause") {
					const paths = storePaths(ctx);
					await locked(ctx, paths.trash, "Session cleanup: pausing…", async (signal) => { const state = await loadState(paths.trash); signal.throwIfAborted(); state.paused = true; await saveState(paths.trash, state); });
					signal.throwIfAborted();
					ctx.ui.notify("Automatic cleanup paused. Run /session-cleanup to review and re-enable it.", "info");
				} else { await ctx.waitForIdle(); signal.throwIfAborted(); await cleanup(ctx, true, action === "preview"); }
			} catch (error) { if (!signal.aborted) ctx.ui.notify(message(error), "error"); }
		},
	});

	pi.registerCommand("session-trash", {
		description: "Search Trash by names, first prompts, IDs or paths; restore a whole family",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("Session Trash requires interactive mode.", "warning");
			cancelAutomatic();
			const signal = lifecycle.signal;
			try {
				await ctx.waitForIdle();
				signal.throwIfAborted();
				const paths = storePaths(ctx);
				await locked(ctx, paths.trash, "Session Trash: loading families…", async (signal) => {
					const store = new RetentionStore(paths.root, paths.trash);
					const { batches, issues } = await store.listTrash();
					signal.throwIfAborted();
					if (issues.length) ctx.ui.notify(issues.join("; "), "warning");
					const choices: TrashChoice[] = [];
					for (const batch of batches.sort((a, b) => b.manifest.trashedAt - a.manifest.trashedAt)) {
						status(ctx, `Session Trash: loading families ${choices.length + 1}/${batches.length}…`);
						const text = await trashSearchText(paths.trash, batch);
						signal.throwIfAborted();
						choices.push({ value: batch.manifest.id, search: text.search, label: text.title || batch.manifest.files[0].original,
							description: `${batch.manifest.files.length} sessions · ${batch.manifest.ready ? "trashed" : "incomplete — recoverable"} · ${new Date(batch.manifest.trashedAt).toISOString().slice(0, 10)} · ${batch.manifest.id.slice(0, 8)}` });
					}
					status(ctx, "Session Trash: choose a family to restore");
					let selected: string | undefined;
					try {
						selected = await ctx.ui.custom<string | undefined>(async (tui, theme, keybindings, done) => {
							closeDialog = () => done(undefined);
							const { SessionTrashDialog } = await import("./dialog.ts");
							signal.throwIfAborted();
							return new SessionTrashDialog(tui, theme, keybindings, choices, cleanText(args), done);
						}, DIALOG_OVERLAY);
					} finally { closeDialog = undefined; }
					signal.throwIfAborted();
					const match = batches.find((batch) => batch.manifest.id === selected);
					if (!match) return;
					status(ctx, "Session Trash: confirming restore…");
					const approved = await ctx.ui.confirm("Restore this session family?", `${match.manifest.files.length} sessions will return to their original locations with a fresh 30-day grace period. Existing files will not be overwritten.`, { signal });
					signal.throwIfAborted();
					if (!approved) return;
					status(ctx, `Session Trash: restoring ${match.manifest.files.length} sessions…`);
					await store.restoreFamily(match.manifest.id, { now: now(), guard: mutationGuard(ctx) });
					signal.throwIfAborted();
					ctx.ui.notify("Session family restored. It is available in normal session search again.", "info");
				});
			} catch (error) { if (!signal.aborted) ctx.ui.notify(message(error), "error"); }
		},
	});
}
