import type { ExtensionAPI, ExtensionContext, SessionBeforeSwitchEvent, SessionBeforeForkEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID, createHash } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { TrashSearchCache } from "./search-cache.ts";
import { RETENTION_MS, RetentionStore, pathKey, type Guard } from "./core.ts";
import { maintenanceGuard, withLock } from "./safety.ts";
import { SessionRegistry } from "./sessions.ts";
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

export default function sessionRetention(pi: ExtensionAPI, options: {
	guard?: () => Promise<void>; now?: () => number; sessions?: SessionRegistry;
	dialog?: typeof import("./dialog.ts").SessionTrashDialog;
} = {}) {
	const now = options.now ?? Date.now;
	const sessions = options.sessions ?? new SessionRegistry(join(resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")), "session-retention"));
	let registration: Promise<void> | undefined;
	const pendingPaths = new Set<string>();
	const currentPaths = (ctx: ExtensionContext) => {
		// New/forked sessions can have an allocated filename before the child header
		// exists on disk. Protect the parent too so scanning can still find its family.
		const path = ctx.sessionManager.getSessionFile();
		const parent = ctx.sessionManager.getHeader?.()?.parentSession;
		return [path, parent].filter((value): value is string => typeof value === "string");
	};
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
	async function discardSearchCache(ctx: ExtensionContext, trash: string, ids: string[]) {
		try { await new TrashSearchCache(trash).remove(ids); }
		catch (error) { try { ctx.ui.notify(`Session search metadata could not be removed: ${message(error)}`, "warning"); } catch { /* Advisory metadata cannot undo a completed file operation. */ } }
	}
	async function locked<T>(ctx: ExtensionContext, trash: string, label: string, work: (signal: AbortSignal, activePaths: () => Promise<string[]>) => Promise<T>): Promise<T> {
		const signal = lifecycle.signal;
		signal.throwIfAborted();
		if (maintaining) throw new Error("Session maintenance is already running.");
		maintaining = true;
		try {
			status(ctx, label);
			const running = (async () => {
				await registration;
				signal.throwIfAborted();
				await sessions.register([...currentPaths(ctx), ...pendingPaths]);
				signal.throwIfAborted();
				return sessions.maintain(activePaths => withLock(trash, async () => { signal.throwIfAborted(); return work(signal, activePaths); }));
			})();
			operation = running;
			return await running;
		} finally { operation = undefined; maintaining = false; if (!signal.aborted) status(ctx, undefined); }
	}
	function mutationGuard(ctx: ExtensionContext, activePaths: () => Promise<string[]>): Guard {
		const probe = maintenanceGuard(options.guard ?? (async () => {}));
		const signal = lifecycle.signal;
		return async (_operation, paths) => {
			signal.throwIfAborted();
			const active = new Set([...currentPaths(ctx), ...await activePaths()].map(pathKey));
			if (paths.some(path => active.has(pathKey(path)))) throw new Error("Refusing to move or delete an open session.");
			const allowed = await probe();
			signal.throwIfAborted();
			return allowed;
		};
	}
	const preventSwitch = async (event: SessionBeforeSwitchEvent | SessionBeforeForkEvent, ctx: ExtensionContext) => {
		if (maintaining) {
			ctx.ui.notify("Finish or cancel session maintenance before switching sessions.", "warning");
			return { cancel: true };
		}
		try {
			await registration;
			if (maintaining) {
				ctx.ui.notify("Finish or cancel session maintenance before switching sessions.", "warning");
				return { cancel: true };
			}
			// Retain BOTH paths if a later handler cancels. Never drop current protection
			// until the replacement runtime registers itself in session_start.
			const target = "targetSessionFile" in event ? event.targetSessionFile : undefined;
			if (target) pendingPaths.add(target);
			await sessions.register([...currentPaths(ctx), ...pendingPaths]);
		} catch (error) {
			ctx.ui.notify(`${message(error)} Session change cancelled; retry after maintenance finishes.`, "warning");
			return { cancel: true };
		}
	};
	pi.on("session_before_switch", preventSwitch);
	pi.on("session_before_fork", preventSwitch);
	function cancelAutomatic() {
		pendingAutomatic = false;
		if (automaticTimer !== undefined) clearTimeout(automaticTimer);
		automaticTimer = undefined;
	}
	async function waitForAutomatic(ctx: ExtensionContext) {
		const running = automatic;
		if (!running) return;
		status(ctx, "Session maintenance: waiting for automatic cleanup…");
		await running;
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
		await registration;
		registration = undefined;
		pendingPaths.clear();
		// Keep the last protection through reload/replacement. Dead-PID records are
		// ignored, and process start times prevent PID reuse from validating them.
		started = false;
	});

	async function cleanup(ctx: ExtensionContext, manual: boolean, previewOnly = false) {
		if (ctx.mode !== "tui") return;
		const paths = storePaths(ctx);
		await locked(ctx, paths.trash, "Session cleanup: checking schedule…", async (signal, activePaths) => {
			const state = await loadState(paths.trash);
			signal.throwIfAborted();
			const time = now();
			if (!manual && (state.paused || time - state.lastRun < DAY)) return;
			const store = new RetentionStore(paths.root, paths.trash);
			status(ctx, "Session cleanup: checking open sessions…");
			const protectedPaths = [...currentPaths(ctx), ...await activePaths()];
			signal.throwIfAborted();
			status(ctx, "Session cleanup: scanning sessions…");
			const scan = await store.scan({ now: time, protectedPaths });
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
				"Named sessions follow the same rule. Every registered open session's family is protected.",
				"Other updated Pi windows may stay open; session changes are blocked during maintenance.",
				"Do not launch another Pi process during maintenance.",
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
			const guard = mutationGuard(ctx, activePaths);
			status(ctx, "Session cleanup: verifying open sessions…");
			await guard("trash", []);
			if (scan.candidates.length) {
				status(ctx, `Session cleanup: moving ${count} sessions to Trash…`);
				await store.trashFamilies(scan.candidates, { now: time, guard });
			}
			signal.throwIfAborted();
			status(ctx, "Session cleanup: purging expired Trash…");
			const purged = await store.purgeExpired({ now: time, guard });
			await discardSearchCache(ctx, paths.trash, purged.purged);
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
		// Register every mode, but never await OS inventory on the startup path.
		if (!registration) {
			const signal = lifecycle.signal;
			registration = sessions.register(currentPaths(ctx), signal).catch(error => {
				if (!signal.aborted) { try { ctx.ui.notify(message(error), "warning"); } catch { /* Detached startup task. */ } }
			});
		}
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
				await waitForAutomatic(ctx);
				signal.throwIfAborted();
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
				await waitForAutomatic(ctx);
				signal.throwIfAborted();
				await ctx.waitForIdle();
				signal.throwIfAborted();
				const paths = storePaths(ctx);
				await locked(ctx, paths.trash, "Session Trash: loading families…", async (signal, activePaths) => {
					const store = new RetentionStore(paths.root, paths.trash);
					const { batches, issues } = await store.listTrash();
					signal.throwIfAborted();
					if (issues.length) ctx.ui.notify(issues.join("; "), "warning");
					batches.sort((a, b) => b.manifest.trashedAt - a.manifest.trashedAt);
					const choices: TrashChoice[] = batches.map(({ manifest }) => ({
						value: manifest.id, members: manifest.files.length, group: manifest.files[0]?.original.split("/")[0] ?? "", search: cleanText([manifest.id, ...manifest.files.map(file => file.original)].join(" ")),
						label: cleanText(manifest.files.map(file => file.original).join(" / ")),
						description: `${manifest.files.length} sessions · ${manifest.ready ? "trashed" : "incomplete — recoverable"} · ${new Date(manifest.trashedAt).toISOString().slice(0, 10)} · ${manifest.id.slice(0, 8)}`,
					}));
					const currentBatch = async (id: string) => {
						const original = batches.find(batch => batch.manifest.id === id);
						const fresh = await store.getTrashBatch(id);
						if (!original || JSON.stringify(original.manifest) !== JSON.stringify(fresh.manifest)) throw new Error("Session family changed. Close and reopen /session-trash before previewing or restoring it.");
						return fresh;
					};
					const cache = new TrashSearchCache(paths.trash);
					const indexing = new AbortController();
					const indexSignal = AbortSignal.any([signal, indexing.signal]);
					let task: Promise<void> | undefined;
					let selected: string | undefined;
					let dialog: import("./dialog.ts").SessionTrashDialog | undefined;
					status(ctx, "Session Trash: choose a family to restore");
					try {
						selected = await ctx.ui.custom<string | undefined>(async (tui, theme, keybindings, done) => {
							const finish = (value: string | undefined) => { indexing.abort(); done(value); };
							closeDialog = () => finish(undefined);
							const Dialog = options.dialog ?? (await import("./dialog.ts")).SessionTrashDialog;
							indexSignal.throwIfAborted();
							dialog = new Dialog(tui, theme, keybindings, choices, cleanText(args), finish, async (id, member, previewSignal) => {
								const combined = AbortSignal.any([signal, previewSignal]);
								combined.throwIfAborted();
								const fresh = await currentBatch(id);
								combined.throwIfAborted();
								const { loadTrashPreview } = await import("./preview.ts");
								const excerpt = await loadTrashPreview(paths.trash, fresh, member, combined);
								await currentBatch(id);
								combined.throwIfAborted();
								return excerpt;
							});
							const activeDialog = dialog;
							let completed = 0, failed = 0;
							dialog.update(choices, { completed, total: batches.length, failed });
							task = (async () => {
								// Mount the picker before starting even a cold transcript read.
								await setImmediate(undefined, { signal: indexSignal });
								for (const [i, batch] of batches.entries()) {
									indexSignal.throwIfAborted();
									try {
										const text = await cache.read(batch, indexSignal);
										indexSignal.throwIfAborted();
										choices[i] = { ...choices[i], search: text.search, label: text.title || choices[i].label, ...(text.cwd ? { cwd: text.cwd } : {}) };
									} catch (error) {
										if (indexSignal.aborted) return;
										failed++;
										choices[i] = { ...choices[i], description: `${choices[i].description} · search metadata unavailable` };
									}
									if (indexSignal.aborted) return;
									activeDialog.update([...choices], { completed: ++completed, total: batches.length, failed });
								}
							})().catch(error => {
								if (!indexSignal.aborted) { try { ctx.ui.notify(message(error), "warning"); } catch { /* Detached indexing error. */ } }
							});
							return dialog;
						}, DIALOG_OVERLAY);
					} finally {
						indexing.abort();
						try { await Promise.all([task, dialog?.drain?.()]); }
						finally { closeDialog = undefined; }
					}
					signal.throwIfAborted();
					const match = batches.find((batch) => batch.manifest.id === selected);
					if (!match) return;
					await currentBatch(match.manifest.id);
					signal.throwIfAborted();
					status(ctx, "Session Trash: confirming restore…");
					const approved = await ctx.ui.confirm("Restore this session family?", `${match.manifest.files.length} sessions will return to their original locations with a fresh 30-day grace period. Existing files will not be overwritten.`, { signal });
					signal.throwIfAborted();
					if (!approved) return;
					status(ctx, `Session Trash: restoring ${match.manifest.files.length} sessions…`);
					await store.restoreFamily(match.manifest.id, { now: now(), guard: mutationGuard(ctx, activePaths) });
					await discardSearchCache(ctx, paths.trash, [match.manifest.id]);
					signal.throwIfAborted();
					ctx.ui.notify("Session family restored. It is available in normal session search again.", "info");
				});
			} catch (error) { if (!signal.aborted) ctx.ui.notify(message(error), "error"); }
		},
	});
}
