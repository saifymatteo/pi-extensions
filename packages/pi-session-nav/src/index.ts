import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DIALOG_OVERLAY, dialogRows, wheelAsArrows } from "./lib/dialog.ts";

type Entry = { id: string; type: string; firstKeptEntryId?: string; message?: { role?: string; content?: unknown; timestamp?: number } };
type NavItem = { id: string; role: string; preview: string; timestamp: number; available: boolean };

let lastSelectedId: string | null = null;

function cleanText(value: unknown): string {
	const blocks = typeof value === "string" ? [{ type: "text", text: value }] : Array.isArray(value) ? value : [];
	return blocks.flatMap((block: any) => block?.type === "text" && typeof block.text === "string" ? [block.text] : block?.type === "image" ? ["[image]"] : [])
		.join(" ").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

export function activeContextIds(branch: Entry[]): Set<string> {
	const latestCompactionIndex = branch.reduce((latest, entry, index) => entry.type === "compaction" ? index : latest, -1);
	if (latestCompactionIndex < 0) return new Set(branch.map((entry) => entry.id));
	const compaction = branch[latestCompactionIndex];
	const keptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	const ids = new Set<string>([compaction.id]);
	if (keptIndex >= 0 && keptIndex < latestCompactionIndex) {
		for (const entry of branch.slice(keptIndex, latestCompactionIndex)) ids.add(entry.id);
	}
	for (const entry of branch.slice(latestCompactionIndex + 1)) ids.add(entry.id);
	return ids;
}

export function buildNavigationItems(branch: Entry[], activeIds: Set<string>): NavItem[] {
	return branch.flatMap((entry) => {
		if (entry.type !== "message" || (entry.message?.role !== "user" && entry.message?.role !== "assistant")) return [];
		const preview = cleanText(entry.message.content);
		// Assistant messages with no visible text are usually tool-call-only messages.
		if (!preview || !activeIds.has(entry.id)) return [];
		return [{ id: entry.id, role: entry.message.role, preview, timestamp: entry.message.timestamp ?? 0, available: true }];
	});
}

export function visibleRange(selected: number, itemCount: number, pageSize: number): number {
	return Math.max(0, Math.min(selected - pageSize + 1, itemCount - pageSize));
}

function normalizeForMatch(value: unknown): string {
	return cleanText(value).normalize("NFKC").toLocaleLowerCase();
}

function visibleMessageText(message: any): string {
	return cleanText(message?.content);
}

function walkComponents(root: any, out: any[] = [], seen = new Set<any>()): any[] {
	if (!root || seen.has(root)) return out;
	seen.add(root);
	out.push(root);
	for (const child of root.children ?? []) walkComponents(child, out, seen);
	if (root.child && root.child !== root) walkComponents(root.child, out, seen);
	return out;
}

function jumpToMessage(tui: any, item: NavItem, targetMessage: any, items: NavItem[]): boolean {
	try {
		if (tui?.mode !== "fullscreen") return false;
		const layout = tui.currentLayout?.primaryScrollView;
		const scroll = layout?.primary && typeof layout.scrollTo === "function" ? layout : walkComponents(tui.layoutRoot).find((component) => component.primary && typeof component.scrollTo === "function");
		const doc = scroll?.child;
		if (!scroll || !doc) return false;
		const components = walkComponents(doc);
		const targetText = normalizeForMatch(visibleMessageText(targetMessage));
		const candidates = components.filter((component) => item.role === "user"
			? typeof component.text === "string" && typeof component.rebuild === "function"
			: component.lastMessage?.role === "assistant");
		const matching = candidates.filter((component) => normalizeForMatch(item.role === "user" ? component.text : visibleMessageText(component.lastMessage)) === targetText);
		const itemIndex = items.findIndex((candidate) => candidate.id === item.id);
		if (itemIndex < 0) return false;
		const occurrence = items.slice(0, itemIndex)
			.filter((candidate) => candidate.role === item.role && normalizeForMatch(candidate.preview) === targetText).length;
		const target = matching[occurrence];
		if (!target) return false;
		const width = Math.max(1, scroll.getContentWidth(tui.terminal?.columns ?? 80));
		const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		const targetLines = target.render(width).map((line: string) => stripAnsi(line));
		const firstRenderedLine = targetLines.find((line: string) => line.trim().length > 0);
		if (!firstRenderedLine) return false;
		const sameBefore = candidates.slice(0, candidates.indexOf(target))
			.filter((component) => component.render(width).some((line: string) => stripAnsi(line) === firstRenderedLine)).length;
		const docLines: string[] = doc.render(width);
		let occurrenceInDocument = 0;
		let offset = -1;
		for (let index = 0; index < docLines.length; index++) {
			if (stripAnsi(docLines[index]) === firstRenderedLine && occurrenceInDocument++ === sameBefore) {
				offset = index;
				break;
			}
		}
		if (offset < 0) return false;
		scroll.scrollTo(offset, { disableFollow: true });
		tui.requestRender?.();
		return true;
	} catch {
		return false;
	}
}

class Navigator implements Component {
	private selected: number;
	private offset: number;
	// Fixed lines: 2 borders, 2 blank spacers, footer.
	private get pageSize(): number { return dialogRows(this.tui, 5); }

	constructor(private readonly tui: any, private readonly items: NavItem[], private readonly done: (id: string | null) => void, private readonly theme: any, initialIndex: number) {
		this.selected = Math.max(0, Math.min(initialIndex, items.length - 1));
		this.offset = visibleRange(this.selected, items.length, this.pageSize);
	}
	invalidate(): void {}

	render(width: number): string[] {
		const border = (text: string) => this.theme.fg("border", text);
		const inner = Math.max(1, width - 2);
		const contentWidth = Math.max(1, inner - 2);
		const title = ` Navigate conversation · ${this.items.length} messages `;
		const topTitle = truncateToWidth(title, Math.max(1, inner - 1), "…");
		const lines = [border(`┏${topTitle}${"━".repeat(Math.max(0, inner - visibleWidth(topTitle)))}┓`)];
		const messageRow = (text: string, role: "user" | "assistant", selected: boolean) => {
			const fitted = truncateToWidth(text, contentWidth, "…");
			const padded = ` ${fitted}${" ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)))} `;
			const styledText = role === "user"
				? this.theme.bg("userMessageBg", this.theme.fg(selected ? "warning" : "userMessageText", padded))
			: this.theme.fg(selected ? "warning" : "dim", padded);
			return border("┃") + styledText + border("┃");
		};
		const plainRow = (text: string) => {
			const fitted = truncateToWidth(text, contentWidth, "…");
			return border("┃") + ` ${fitted}${" ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)))} ` + border("┃");
		};
		lines.push(plainRow(""));
		const list = this.items.slice(this.offset, this.offset + this.pageSize);
		for (let index = 0; index < this.pageSize; index++) {
			const item = list[index];
			const isSelected = this.offset + index === this.selected;
			if (!item) {
				lines.push(plainRow(""));
				continue;
			}
			const prefix = isSelected ? "▶ " : "  ";
			const isLatest = this.offset + index === this.items.length - 1;
			const row = `${prefix}${item.role === "user" ? "You" : "Pi"}${isLatest ? " · latest" : ""}: ${item.preview}`;
			lines.push(messageRow(row, item.role as "user" | "assistant", isSelected));
		}
		lines.push(plainRow(""));
		lines.push(plainRow(this.theme.fg("dim", `↑↓/PgUp/PgDn · Home/End · ${this.selected + 1}/${this.items.length} · Enter jump · Esc close`)));
		lines.push(border(`┗${"━".repeat(inner)}┛`));
		return lines;
	}

	handleMouse(event: TuiMouseEvent) { return wheelAsArrows(event, (key) => this.handleInput(key)); }

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(null);
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(this.items.length - 1, this.selected + 1);
		else if (matchesKey(data, "pageUp")) this.selected = Math.max(0, this.selected - this.pageSize);
		else if (matchesKey(data, "pageDown")) this.selected = Math.min(this.items.length - 1, this.selected + this.pageSize);
		else if (matchesKey(data, "home")) this.selected = 0;
		else if (matchesKey(data, "end")) this.selected = Math.max(0, this.items.length - 1);
		else if (matchesKey(data, "enter")) {
			const item = this.items[this.selected];
			if (item) {
				lastSelectedId = item.id;
				this.done(item.available ? item.id : `hidden:${item.id}`);
			}
		}
		this.offset = visibleRange(this.selected, this.items.length, this.pageSize);
		this.tui.requestRender();
	}
}

export default function (pi: ExtensionAPI): void {
	async function open(ctx: any): Promise<void> {
		const sessionManager = ctx.sessionManager;
		const entries = sessionManager.getEntries() as Entry[];
		const branch = sessionManager.getBranch() as Entry[];
		let activeIds: Set<string>;
		try {
			const contextEntries = typeof sessionManager.buildContextEntries === "function" ? sessionManager.buildContextEntries() : undefined;
			activeIds = Array.isArray(contextEntries) ? new Set(contextEntries.map((entry: Entry) => entry.id)) : activeContextIds(branch);
		} catch {
			activeIds = activeContextIds(branch);
		}
		const items = buildNavigationItems(branch, activeIds);
		if (!items.length) return ctx.ui.notify("No user or assistant messages in this session", "info");
		const previousIndex = lastSelectedId ? items.findIndex((item) => item.id === lastSelectedId) : -1;
		const initialIndex = previousIndex >= 0 ? previousIndex : items.length - 1;
		let tuiRef: any;
		const selected: string | null = await ctx.ui.custom((tui, theme, _keybindings, done) => {
			tuiRef = tui;
			return new Navigator(tui, items, done, theme, initialIndex);
		}, DIALOG_OVERLAY);
		if (selected === null) return;
		if (selected.startsWith("hidden:")) return ctx.ui.notify("That message is hidden by compaction and cannot be jumped to", "warning");
		const item = items.find((candidate) => candidate.id === selected);
		const entry = entries.find((candidate) => candidate.id === selected);
		if (!item?.available || !entry || entry.type !== "message") return ctx.ui.notify("Message is no longer available in this session", "warning");
		if (!jumpToMessage(tuiRef, item, entry.message, items)) ctx.ui.notify("Could not locate that message in the visible transcript", "warning");
	}
	pi.registerCommand("session-nav", { description: "Navigate to a message in the current conversation", handler: async (_args, ctx) => open(ctx) });
	pi.registerShortcut(Key.alt("o"), { description: "Navigate conversation", handler: async (ctx) => open(ctx) });
}
