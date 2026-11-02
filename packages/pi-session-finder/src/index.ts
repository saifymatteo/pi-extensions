import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DIALOG_OVERLAY, dialogRows, wheelAsArrows } from "./lib/dialog.ts";
import { createReadStream } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

type SessionInfo = { id: string; path: string; cwd: string; parentSession?: string; name?: string; firstMessage: string; modified: number };
type TreeRow = { kind: "folder"; label: string } | { kind: "session"; session: SessionInfo; treePrefix: string };

function sameDirectory(a: string, b: string): boolean {
	const left = resolve(a), right = resolve(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: any) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join(" ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

async function discoverSessionFiles(roots: string[]): Promise<string[]> {
	const files = new Set<string>();
	const visited = new Set<string>();
	async function visit(dir: string): Promise<void> {
		let real: string;
		try { real = resolve(dir); } catch { return; }
		if (visited.has(real)) return;
		visited.add(real);
		let entries;
		try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(path);
		}
	}
	for (const root of roots) await visit(root);
	return [...files];
}

async function readSessionInfo(path: string): Promise<SessionInfo | null> {
	let header: any;
	let name: string | undefined;
	let parentSession: string | undefined;
	let firstMessage = "";
	try {
		const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
		for await (const line of lines) {
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			if (!header && entry.type === "session") {
				header = entry;
				if (typeof entry.parentSession === "string") parentSession = entry.parentSession;
			}
			else if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
			else if (!firstMessage && entry.type === "message" && entry.message?.role === "user") firstMessage = contentText(entry.message.content);
		}
	} catch { return null; }
	if (header?.type !== "session" || typeof header.id !== "string") return null;
	let modified = 0;
	try { modified = (await stat(path)).mtimeMs; } catch { /* file may disappear during scan */ }
	return { id: header.id, path, cwd: typeof header.cwd === "string" ? header.cwd : "(unknown directory)", parentSession, name, firstMessage, modified };
}

export function buildSessionRows(sessions: SessionInfo[], query: string): TreeRow[] {
	const needle = query.trim().toLocaleLowerCase();
	const matches = (session: SessionInfo) => !needle || [session.name, session.cwd, session.firstMessage, session.id]
		.some((value) => value?.toLocaleLowerCase().includes(needle));
	const byPath = new Map(sessions.map((session) => [resolve(session.path), session]));
	const included = new Set(sessions.filter(matches));
	// Keep ancestors visible as context when a search matches only a child session.
	for (const session of [...included]) {
		let parent = session.parentSession ? byPath.get(resolve(session.parentSession)) : undefined;
		while (parent && !included.has(parent)) {
			included.add(parent);
			parent = parent.parentSession ? byPath.get(resolve(parent.parentSession)) : undefined;
		}
	}
	const children = new Map<string, SessionInfo[]>();
	const roots = new Map<string, SessionInfo[]>();
	for (const session of included) {
		const parent = session.parentSession ? byPath.get(resolve(session.parentSession)) : undefined;
		if (parent && included.has(parent) && sameDirectory(parent.cwd, session.cwd)) {
			const list = children.get(parent.id) ?? [];
			list.push(session);
			children.set(parent.id, list);
		} else {
			const list = roots.get(session.cwd) ?? [];
			list.push(session);
			roots.set(session.cwd, list);
		}
	}
	// A recently active fork promotes its whole branch, family, and project.
	const activity = new Map<SessionInfo, number>();
	const latestActivity = (session: SessionInfo): number => {
		const cached = activity.get(session);
		if (cached !== undefined) return cached;
		let latest = session.modified;
		activity.set(session, latest); // Guard against malformed parent cycles.
		for (const child of children.get(session.id) ?? []) latest = Math.max(latest, latestActivity(child));
		activity.set(session, latest);
		return latest;
	};
	const newestFirst = (a: SessionInfo, b: SessionInfo) => latestActivity(b) - latestActivity(a);
	const rows: TreeRow[] = [];
	const addSession = (session: SessionInfo, treePrefix: string, ancestorContinues: boolean[], seen: Set<string>) => {
		if (seen.has(session.id)) return;
		seen.add(session.id);
		rows.push({ kind: "session", session, treePrefix });
		const nested = (children.get(session.id) ?? []).sort(newestFirst);
		nested.forEach((child, index) => {
			const isLast = index === nested.length - 1;
			const continuation = ancestorContinues.map((continues) => continues ? "│     " : "      ").join("");
			// Root labels begin after 2 cells of row padding, 2 root-indent cells, and the 2-cell selector;
			// connect child branches under the label rather than under the selector.
			addSession(child, `       ${continuation}${isLast ? "└─ " : "├─ "}`, [...ancestorContinues, !isLast], seen);
		});
	};
	for (const group of roots.values()) group.sort(newestFirst);
	const groups = [...roots.entries()].sort(([a, aGroup], [b, bGroup]) => newestFirst(aGroup[0], bGroup[0]) || a.localeCompare(b));
	for (const [cwd, group] of groups) {
		rows.push({ kind: "folder", label: cwd });
		for (const session of group) addSession(session, "  ", [], new Set());
	}
	return rows;
}

class SessionFinder implements Component {
	private query = "";
	private selected = 0;
	private offset = 0;
	private rows: TreeRow[];
	// Fixed lines: 2 borders, search, directory, footer.
	private get pageSize(): number { return dialogRows(this.tui, 5); }

	constructor(private readonly tui: any, private readonly sessions: SessionInfo[], private readonly activePath: string | undefined, private readonly done: (path: string | null) => void, private readonly theme: any) {
		this.rows = buildSessionRows(sessions, this.query);
		const activeIndex = this.rows.findIndex((row) => row.kind === "session" && resolve(row.session.path) === activePath);
		if (activeIndex >= 0) {
			this.selected = activeIndex;
			this.offset = Math.max(0, this.selected - this.pageSize + 1);
		} else {
			this.selectFirstSession();
		}
	}

	invalidate(): void {}

	private selectableRows(): number[] {
		return this.rows.flatMap((row, index) => row.kind === "session" ? [index] : []);
	}

	private selectFirstSession(): void {
		const first = this.selectableRows()[0];
		this.selected = first ?? 0;
		this.offset = Math.max(0, this.selected - this.pageSize + 1);
	}

	render(width: number): string[] {
		const border = (value: string) => this.theme.fg("border", value);
		const inner = Math.max(1, width - 2);
		const bodyWidth = Math.max(1, inner - 4);
		const title = truncateToWidth(` Find session · ${this.selectableRows().length} results `, inner - 1, "…");
		const lines = [border(`┏${title}${"━".repeat(Math.max(0, inner - visibleWidth(title)))}┓`)];
		const plainRow = (value: string) => {
			const fitted = truncateToWidth(value, bodyWidth, "…");
			return border("┃") + `  ${fitted}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(fitted)))}  ` + border("┃");
		};
		lines.push(plainRow(this.theme.fg("warning", `Search: ${this.query}▏`)));
		let activeDirectory = "";
		let activeDirectoryIndex = -1;
		for (let i = Math.min(this.offset, this.rows.length - 1); i >= 0; i--) {
			const row = this.rows[i];
			if (row?.kind === "folder") {
				activeDirectory = row.label;
				activeDirectoryIndex = i;
				break;
			}
		}
		lines.push(plainRow(this.theme.fg("dim", `▸ ${activeDirectory || "(no directory)"}`)));
		const visible = this.rows
			.map((row, index) => ({ row, index }))
			.slice(this.offset, this.offset + this.pageSize + 1)
			.filter(({ index }) => index !== activeDirectoryIndex)
			.slice(0, this.pageSize);
		for (let i = 0; i < this.pageSize; i++) {
			const visibleRow = visible[i];
			if (!visibleRow) { lines.push(plainRow("")); continue; }
			const { row, index } = visibleRow;
			if (row.kind === "folder") {
				lines.push(plainRow(this.theme.fg("dim", `▸ ${row.label}`)));
				continue;
			}
			const isSelected = index === this.selected;
			const isActive = resolve(row.session.path) === this.activePath;
			const label = row.session.name || row.session.firstMessage || `Session ${row.session.id.slice(0, 8)}`;
			const item = `${row.treePrefix}${isSelected ? "▶ " : "  "}${isActive ? "● current · " : ""}${label}${row.session.firstMessage && row.session.name ? ` · ${row.session.firstMessage}` : ""}`;
			const fitted = truncateToWidth(item, bodyWidth, "…");
			const padded = `  ${fitted}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(fitted)))}  `;
			const styled = isSelected || isActive ? this.theme.fg("warning", padded) : this.theme.fg("text", padded);
			lines.push(border("┃") + styled + border("┃"));
		}
		lines.push(plainRow(this.theme.fg("dim", "↑↓ navigate · type to search · Enter open · Esc close")));
		lines.push(border(`┗${"━".repeat(inner)}┛`));
		return lines;
	}

	handleMouse(event: TuiMouseEvent) { return wheelAsArrows(event, (key) => this.handleInput(key)); }

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(null);
		if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.rows = buildSessionRows(this.sessions, this.query);
			this.selectFirstSession();
		} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const choices = this.selectableRows();
			const position = choices.indexOf(this.selected);
			const next = matchesKey(data, "up") ? Math.max(0, position - 1) : Math.min(choices.length - 1, position + 1);
			this.selected = choices[next] ?? 0;
		} else if (matchesKey(data, "enter")) {
			const row = this.rows[this.selected];
			if (row?.kind === "session") return this.done(row.session.path);
		} else if (!/[\x00-\x1f\x7f]/.test(data)) {
			this.query += data;
			this.rows = buildSessionRows(this.sessions, this.query);
			this.selectFirstSession();
		}
		this.offset = Math.max(0, Math.min(this.selected - this.pageSize + 1, this.rows.length - this.pageSize));
		this.tui.requestRender();
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("session-global", {
		description: "Find and open a saved session from any project",
		handler: async (_args, ctx) => {
			const destinationCwd = ctx.cwd;
			const destinationSessionDir = ctx.sessionManager.getSessionDir();
			const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
			const roots = [process.env.PI_CODING_AGENT_SESSION_DIR || join(agentDir, "sessions"), destinationSessionDir];
			const files = await discoverSessionFiles(roots);
			const sessions = (await Promise.all(files.map(readSessionInfo))).filter((session): session is SessionInfo => session !== null);
			if (!sessions.length) return ctx.ui.notify("No saved sessions found", "info");
			let selectedPath: string | null;
			try {
				const currentPath = ctx.sessionManager.getSessionFile();
				selectedPath = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => new SessionFinder(tui, sessions, currentPath ? resolve(currentPath) : undefined, done, theme), DIALOG_OVERLAY);
			} catch (error) {
				return ctx.ui.notify(`Could not open session finder: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			if (!selectedPath) return;
			const selected = sessions.find((session) => session.path === selectedPath);
			if (!selected) return;
			if (sameDirectory(selected.cwd, destinationCwd)) {
				const result = await ctx.switchSession(selectedPath);
				if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
				return;
			}
			const choice = await ctx.ui.select(
				`Fork “${selected.name || selected.firstMessage || selected.id}” into this project?\nFrom: ${selected.cwd}\nInto: ${destinationCwd}\nCopies the conversation into a new session. The original stays unchanged. No project files are copied.`,
				["Cancel", "Fork here"],
			);
			if (choice !== "Fork here") return;
			let forkPath: string | undefined;
			const discardFork = async () => {
				if (!forkPath) return;
				try { await unlink(forkPath); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT")
						ctx.ui.notify(`Could not remove unused fork ${forkPath}: ${String(error)}`, "warning");
				}
			};
			try {
				// Use Pi's cross-project fork API; never change the original header or process cwd.
				const fork = SessionManager.forkFrom(selectedPath, destinationCwd, destinationSessionDir);
				forkPath = fork.getSessionFile();
				if (!forkPath) throw new Error("Fork did not create a saved session");
				fork.appendCustomMessageEntry("session-finder-transfer",
					`This conversation was forked from ${selected.cwd} into ${destinationCwd}. The active workspace is now ${destinationCwd}; follow its project instructions. Earlier paths and findings refer to the source project unless explicitly stated otherwise. No project files were copied.`, true);
			} catch (error) {
				await discardFork();
				ctx.ui.notify(`Could not fork session: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			// Let the runtime report activation failures: it may already have replaced ctx.
			const result = await ctx.switchSession(forkPath, {
				withSession: async (fresh) => { fresh.ui.notify("Session forked into this project", "info"); },
			});
			if (result.cancelled) {
				await discardFork();
				ctx.ui.notify("Session fork cancelled", "info");
			}
		},
	});
	pi.registerShortcut(Key.alt("i"), {
		description: "Find and open a saved session",
		handler: async (ctx) => {
			ctx.ui.setEditorText("/find");
		},
	});
}
