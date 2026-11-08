import { posix, win32 } from "node:path";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, Markdown, matchesKey, ScrollView, sliceByColumn, Spacer, stripTerminalSequences, Text, truncateToWidth, visibleWidth, type Component, type Focusable, type KeybindingsManager, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { TrashPreview } from "./preview.ts";
import { dialogRows, wheelAsArrows } from "./lib/dialog.ts";

export type TrashChoice = { value: string; label: string; description: string; search: string; members?: number; group?: string; cwd?: string };
export type TrashPreviewLoader = (id: string, memberIndex: number, signal: AbortSignal) => Promise<TrashPreview>;
export type TrashIndexProgress = { completed: number; total: number; failed: number };
type TrashRow = { kind: "folder"; label: string } | { kind: "family"; choice: TrashChoice };

export class SessionTrashDialog implements Component, Focusable {
	private input = new Input({ prompt: "" });
	private rows: TrashRow[] = [];
	private selectedValue?: string;
	private selectedRow = 0;
	private offset = 0;
	private filtered: TrashChoice[] = [];
	private viewport = 5;
	private progress?: TrashIndexProgress;
	private closed = false;
	private hasFocus = false;
	private preview?: { id: string; member: number; count: number; controller: AbortController };
	private previewContent = new Container();
	private previewValue: TrashPreview | string = "";
	private previewScroll = new ScrollView(this.previewContent, { scrollbar: "hidden", overscroll: "contain" });
	private previewTasks = new Set<Promise<void>>();

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private choices: TrashChoice[],
		query: string,
		private done: (id: string | undefined) => void,
		private loadPreview?: TrashPreviewLoader,
	) {
		this.input.handleInput(query); // Native text insertion leaves the cursor after the prefilled query.
		this.filter();
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.input.focused = value && !this.preview; }

	update(choices: TrashChoice[], progress?: TrashIndexProgress): void {
		if (this.closed) return;
		const selected = this.getSelectedItem()?.value;
		this.choices = choices;
		this.progress = progress;
		this.filter(selected);
		this.refresh();
	}

	private indexStatus(): string {
		if (!this.progress) return "";
		const { completed, total, failed } = this.progress;
		if (completed < total) return `indexing ${completed}/${total}${failed ? ` · ${failed} unavailable` : ""}`;
		return failed ? `search incomplete · ${failed} unavailable` : "";
	}

	private filter(selected?: string): void {
		const query = this.input.getValue().toLowerCase();
		this.filtered = this.choices.filter((choice) => choice.search.toLowerCase().includes(query));
		this.buildList(selected);
	}

	private buildList(selected?: string): void {
		// Families grouped by their originating project directory, newest trash first
		// (the caller pre-sorts). Folder labels prefer a cached real cwd over the
		// encoded session-directory segment.
		if (selected !== undefined) this.selectedValue = selected;
		if (this.selectedValue && !this.filtered.some(choice => choice.value === this.selectedValue)) this.selectedValue = undefined;
		this.selectedValue ??= this.filtered[0]?.value;
		const labels = new Map<string, string>();
		for (const choice of this.filtered) {
			const key = choice.group || "";
			if (!labels.has(key)) labels.set(key, choice.cwd || "");
			else if (choice.cwd && !labels.get(key)) labels.set(key, choice.cwd);
		}
		const rows: TrashRow[] = [];
		const seen = new Set<string>();
		for (const choice of this.filtered) {
			const key = choice.group || "";
			if (!seen.has(key)) { seen.add(key); rows.push({ kind: "folder", label: labels.get(key) || key || "(no project)" }); }
			rows.push({ kind: "family", choice });
		}
		this.rows = rows;
		this.selectedRow = Math.max(0, rows.findIndex(row => row.kind === "family" && row.choice.value === this.selectedValue));
		this.clampOffset();
	}

	getSelectedItem(): TrashChoice | undefined { return this.filtered.find(choice => choice.value === this.selectedValue); }

	private activeFolderIndex(): number {
		for (let i = Math.min(this.selectedRow, this.rows.length - 1); i >= 0; i--) {
			if (this.rows[i]?.kind === "folder") return i;
		}
		return -1;
	}

	private clampOffset(): void {
		this.offset = Math.max(0, Math.min(this.selectedRow - this.viewport + 1, Math.max(0, this.rows.length - this.viewport)));
	}

	private refresh(): void { this.input.invalidate(); this.tui.requestRender(); }

	private setPreviewContent(value: TrashPreview | string = this.previewValue): void {
		this.previewValue = value;
		this.previewContent.clear();
		if (typeof value === "string") {
			this.previewContent.addChild(new Text(value, 0, 0));
			return;
		}
		const markdownTheme = getMarkdownTheme();
		const userOptions = { preserveOrderedListMarkers: true, preserveBackslashEscapes: true };
		const section = (label: string) => this.previewContent.addChild({
			render: (width: number) => {
				const heading = truncateToWidth(`── ${label} `, width, "");
				return [this.theme.fg("muted", markdownTheme.bold(heading) + "─".repeat(Math.max(0, width - visibleWidth(heading))))];
			},
			invalidate() {},
		});
		const message = (role: "user" | "assistant", text: string) => {
			const isUser = role === "user";
			this.previewContent.addChild(new Text(this.theme.fg(isUser ? "mdLink" : "warning", markdownTheme.bold(isUser ? "You" : "Assistant")), 0, 0));
			// Each excerpt retains its native Markdown cache and isolated code fences.
			const body = new Markdown(text, 0, 0, markdownTheme, undefined, isUser ? userOptions : undefined);
			const rail = {
				children: [body],
				render: (width: number) => {
					const inset = width >= 4 ? 3 : 0;
					const prefix = inset ? this.theme.fg("dim", "│") + "  " : "";
					return body.render(Math.max(1, width - inset)).map(line => truncateToWidth(prefix + line, width, ""));
				},
				invalidate: () => body.invalidate(),
			};
			this.previewContent.addChild(rail);
			this.previewContent.addChild(new Spacer(1));
		};
		section("FIRST REQUEST");
		message("user", value.firstRequest || "No user text recorded");
		section("RECENT MESSAGES");
		for (const entry of value.recent) message(entry.role, entry.text);
	}

	private finish(id?: string): void {
		this.dispose();
		this.done(id);
	}

	private openPreview(id: string, member = 0): void {
		const choice = this.choices.find(choice => choice.value === id);
		if (!choice || this.closed) return;
		this.preview?.controller.abort();
		const count = choice.members ?? 1;
		const state = { id, member: (member + count) % count, count, controller: new AbortController() };
		this.preview = state;
		this.input.focused = false;
		this.setPreviewContent("Loading preview…");
		this.previewScroll.scrollToStart();
		this.refresh();
		const current = () => !this.closed && this.preview === state && !state.controller.signal.aborted;
		const task = Promise.resolve().then(async () => {
			state.controller.signal.throwIfAborted();
			if (!this.loadPreview) throw new Error("Preview unavailable");
			return this.loadPreview(id, state.member, state.controller.signal);
		}).then(value => {
			if (!current()) return;
			this.setPreviewContent(value);
			this.refresh();
		}, error => {
			if (!current()) return;
			const reason = stripTerminalSequences(String(error instanceof Error ? error.message : error)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 1000);
			this.setPreviewContent(`Preview unavailable: ${reason}\n\nEsc returns to search. Ctrl+R can still request a freshly validated restore.`);
			this.refresh();
		}).catch(() => { /* The host may dispose its renderer during completion. */ });
		this.previewTasks.add(task);
		void task.then(() => this.previewTasks.delete(task));
	}

	handleMouse(event: TuiMouseEvent) { return wheelAsArrows(event, (key) => this.handleInput(key)); }

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (matchesKey(data, Key.ctrl("c"))) { this.finish(); return; }
		if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			if (this.preview) {
				this.preview.controller.abort();
				this.preview = undefined;
				this.input.focused = this.hasFocus;
				this.refresh();
			} else this.finish();
			return;
		}
		if (matchesKey(data, Key.ctrl("r"))) {
			const id = this.preview?.id ?? this.getSelectedItem()?.value;
			if (id) this.finish(id);
			return;
		}
		if (this.preview) {
			if ((data === "[" || data === "]") && this.preview.count > 1) this.openPreview(this.preview.id, this.preview.member + (data === "[" ? -1 : 1));
			else {
				if (kb.matches(data, "tui.select.up")) this.previewScroll.scrollBy(-1);
				if (kb.matches(data, "tui.select.down")) this.previewScroll.scrollBy(1);
				if (kb.matches(data, "tui.select.pageUp")) this.previewScroll.scrollBy(-Math.max(1, this.previewScroll.viewportHeight));
				if (kb.matches(data, "tui.select.pageDown")) this.previewScroll.scrollBy(Math.max(1, this.previewScroll.viewportHeight));
				if (matchesKey(data, Key.home)) this.previewScroll.scrollToStart();
				if (matchesKey(data, Key.end)) this.previewScroll.scrollToEnd();
				this.refresh();
			}
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.getSelectedItem();
			if (selected) this.openPreview(selected.value);
			return;
		}
		const up = kb.matches(data, "tui.select.up");
		const down = kb.matches(data, "tui.select.down");
		const pageUp = kb.matches(data, "tui.select.pageUp");
		const pageDown = kb.matches(data, "tui.select.pageDown");
		const home = matchesKey(data, Key.home);
		const end = matchesKey(data, Key.end);
		if (up || down || pageUp || pageDown || home || end) {
			const index = this.filtered.findIndex((choice) => choice.value === this.selectedValue);
			const count = this.filtered.length;
			if (count) {
				const next = home ? 0 : end ? count - 1
					: pageUp || pageDown
						? Math.max(0, Math.min(count - 1, index + (pageUp ? -this.viewport : this.viewport)))
						: (index + (up ? -1 : 1) + count) % count;
				this.selectedValue = this.filtered[next]?.value;
				this.buildList(this.selectedValue);
			}
		} else {
			const previous = this.input.getValue();
			this.input.handleInput(data);
			if (previous !== this.input.getValue()) this.filter();
		}
		this.refresh();
	}

	private renderPreview(width: number, height: number): string[] {
		const state = this.preview!;
		const rows = Math.max(1, Math.min(height, dialogRows(this.tui, 0)));
		// Eight fixed chrome rows still need room for a readable first message.
		const compact = width < 16 || rows < 12;
		const bodyWidth = Math.max(1, compact ? width : width - 6);
		const value = typeof this.previewValue === "string" ? undefined : this.previewValue;
		const member = `Session ${state.member + 1}/${state.count}${state.count > 1 ? " · [ ] switch" : ""} · read-only`;
		const notice = value ? `Preview only · ${value.truncated ? "Some content shortened" : "Current branch · Tools/thinking omitted"}` : "Read-only preview";
		const footer = `↑↓ PgUp/PgDn Home/End scroll · Ctrl+R restore all ${state.count} · Esc back`;
		const head = rows >= 3 ? [this.theme.fg("muted", member)] : [];
		const tail = [...(rows >= 4 ? [this.theme.fg("muted", notice)] : []), ...(rows >= 2 ? [this.theme.fg("dim", footer)] : [])];
		const capacity = Math.max(1, rows - (compact ? head.length + tail.length : 8));
		const content = this.previewScroll.render(bodyWidth);
		this.previewScroll.updateLayout(content.length, capacity, () => this.tui.requestRender());
		const visible = content.slice(this.previewScroll.scrollTop, this.previewScroll.scrollTop + capacity);
		if (compact) return [...head, ...visible, ...tail].map(line => truncateToWidth(line, width, ""));
		while (visible.length < capacity) visible.push("");
		const border = (text: string) => this.theme.fg("border", text);
		const row = (text: string, color: "text" | "muted" | "dim" = "text") => {
			const fitted = truncateToWidth(text, bodyWidth, "…");
			return border("┃  ") + this.theme.fg(color, fitted + " ".repeat(Math.max(0, bodyWidth - visibleWidth(fitted)))) + border("  ┃");
		};
		const cwd = (value?.cwd || "").replace(/[\r\n\t]/g, " ");
		const project = (/^[a-z]:[\\/]|^\\\\/i.test(cwd) ? win32 : posix).basename(cwd) || cwd || (value ? "Project not recorded" : "");
		const projectWidth = bodyWidth - visibleWidth(` · ${member}`);
		const metadata = project && projectWidth >= 6 ? `${truncateToWidth(project, projectWidth, "…")} · ${member}` : member;
		const pathWidth = visibleWidth(cwd);
		const path = pathWidth > bodyWidth ? `…${sliceByColumn(cwd, pathWidth - bodyWidth + 1, bodyWidth - 1, true)}` : cwd;
		const label = (value?.name || this.choices.find(choice => choice.value === state.id)?.label || state.id).replace(/[\r\n\t]/g, " ");
		const title = truncateToWidth(` Session Trash › ${label} `, width - 3, "…");
		return [border(`┏${title}${"━".repeat(Math.max(0, width - 2 - visibleWidth(title)))}┓`), row(metadata, "muted"), row(path, "muted"), row(""), ...visible.map(line => row(line)), border(`┣${"━".repeat(width - 2)}┫`), row(notice, "muted"), row(footer, "dim"), border(`┗${"━".repeat(width - 2)}┛`)];
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows);
		if (this.preview) return this.renderPreview(width, height);
		// Fixed lines: 2 borders, search, active-folder header, footer, list scroll info.
		const viewport = dialogRows(this.tui, 6);
		if (viewport !== this.viewport) {
			this.viewport = viewport;
			this.buildList(this.selectedValue);
		}
		// Below the frame's minimum size, keep the native input/cursor usable.
		if (width < 16 || height < 8) return [
			...this.input.render(Math.max(1, width)),
			...(this.indexStatus() ? [this.indexStatus()] : []),
			...this.windowLines(this.viewport).map((line) => this.theme.fg(line.startsWith("▶ ") ? "warning" : "text", line)),
		].slice(0, height).map((line) => truncateToWidth(line, Math.max(0, width), ""));

		// Match session-finder.ts: heavy border, two-cell padding and warning selection.
		const border = (value: string) => this.theme.fg("border", value);
		const inner = width - 2;
		const bodyWidth = inner - 4;
		const progress = this.indexStatus();
		const title = truncateToWidth(` Session Trash${progress ? ` · ${progress}` : ""} · ${this.filtered.length} results `, inner - 1, "…");
		const row = (value: string, color: "text" | "warning" | "dim" | "muted" = "text") => {
			const fitted = truncateToWidth(value, bodyWidth, "…");
			const padded = `  ${fitted}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(fitted)))}  `;
			return border("┃") + this.theme.fg(color, padded) + border("┃");
		};
		const lines = [border(`┏${title}${"━".repeat(Math.max(0, inner - visibleWidth(title)))}┓`)];
		for (const line of this.input.render(bodyWidth - 8)) lines.push(row(`Search: ${line}`, "warning"));
		// Match session-finder.ts: the selected family's folder stays fixed above the
		// scrolling list, and inline folder headers skip the fixed copy. With no rows,
		// render the empty-state text instead of folder chrome.
		const folderIndex = this.activeFolderIndex();
		if (!this.rows.length) {
			const empty = this.indexStatus() ? `No matches yet — ${this.indexStatus()}` : this.choices.length ? "No matching families" : "Trash empty";
			lines.push(row(this.theme.fg("muted", empty), "muted"));
			for (let i = 1; i < this.viewport + 1; i++) lines.push(row(""));
		} else {
			const folder = folderIndex >= 0 && this.rows[folderIndex]?.kind === "folder" ? this.rows[folderIndex].label : "(no project)";
			lines.push(row(this.theme.fg("dim", `▸ ${folder}`), "dim"));
			for (const line of this.windowLines(this.viewport, folderIndex)) lines.push(row(line, line.startsWith("▶ ") ? "warning" : line.startsWith("▸ ") ? "dim" : "text"));
		}
		const info = this.rows.length > this.viewport ? `  (${Math.max(0, this.filtered.findIndex(choice => choice.value === this.selectedValue) + 1) || 1}/${this.filtered.length})` : "";
		lines.push(row(this.theme.fg("dim", info), "dim"));
		lines.push(row("↑↓ navigate · Home/End jump · type to search · Enter preview · Ctrl+R restore · Esc close", "dim"));
		lines.push(border(`┗${"━".repeat(inner)}┛`));
		return lines;
	}

	/** Windowed list rows: folder headers plus the selected family marker. */
	private windowLines(count: number, skipFolderIndex = -1): string[] {
		// Like session-finder: slice rows, drop the fixed folder copy, cap at `count`.
		const window: string[] = [];
		for (let i = this.offset; i < this.rows.length && window.length < count; i++) {
			if (i === skipFolderIndex) continue;
			const entry = this.rows[i];
			window.push(entry.kind === "folder" ? `▸ ${entry.label}` : `${entry.choice.value === this.selectedValue ? "▶ " : "  "}${entry.choice.label}${entry.choice.description ? ` · ${entry.choice.description}` : ""}`);
		}
		while (window.length < count) window.push("");
		return window;
	}

	dispose(): void {
		this.closed = true;
		this.preview?.controller.abort();
		this.input.focused = false;
	}

	async drain(): Promise<void> {
		this.dispose();
		await Promise.all([...this.previewTasks]);
	}

	invalidate(): void {
		this.input.invalidate();
		this.setPreviewContent();
		this.previewScroll.invalidate();
	}
}
