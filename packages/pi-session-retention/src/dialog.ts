import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, SelectList, truncateToWidth, visibleWidth, type Component, type Focusable, type KeybindingsManager, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { dialogRows, wheelAsArrows } from "./lib/dialog.ts";

export type TrashChoice = { value: string; label: string; description: string; search: string };

export class SessionTrashDialog implements Component, Focusable {
	private input = new Input({ prompt: "" });
	private list!: SelectList;
	private filtered: TrashChoice[] = [];
	private viewport = 5;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private choices: TrashChoice[],
		query: string,
		private done: (id: string | undefined) => void,
	) {
		this.input.handleInput(query); // Native text insertion leaves the cursor after the prefilled query.
		this.filter();
	}

	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }

	private filter(): void {
		const query = this.input.getValue().toLowerCase();
		this.filtered = this.choices.filter((choice) => choice.search.toLowerCase().includes(query));
		this.buildList();
	}

	private buildList(selected?: string): void {
		this.list = new SelectList(this.filtered, this.viewport, {
			selectedPrefix: (text) => text,
			selectedText: (text) => text.replace(/^→ /, "▶ "),
			description: (text) => text,
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: () => this.theme.fg("muted", this.choices.length ? "No matching families" : "Trash empty"),
		});
		if (selected !== undefined) this.list.setSelectedIndex(Math.max(0, this.filtered.findIndex((choice) => choice.value === selected)));
	}

	handleMouse(event: TuiMouseEvent) { return wheelAsArrows(event, (key) => this.handleInput(key)); }

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.list.getSelectedItem();
			if (selected) this.done(selected.value);
			return;
		}
		const up = kb.matches(data, "tui.select.up");
		const down = kb.matches(data, "tui.select.down");
		const pageUp = kb.matches(data, "tui.select.pageUp");
		const pageDown = kb.matches(data, "tui.select.pageDown");
		if (up || down || pageUp || pageDown) {
			const index = this.filtered.findIndex((choice) => choice.value === this.list.getSelectedItem()?.value);
			const count = this.filtered.length;
			if (count) {
				const next = pageUp || pageDown
					? Math.max(0, Math.min(count - 1, index + (pageUp ? -this.viewport : this.viewport)))
					: (index + (up ? -1 : 1) + count) % count;
				this.list.setSelectedIndex(next);
			}
		} else {
			const previous = this.input.getValue();
			this.input.handleInput(data);
			if (previous !== this.input.getValue()) this.filter();
		}
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows);
		// Fixed lines: 2 borders, search, footer, list scroll info.
		const viewport = dialogRows(this.tui, 5);
		if (viewport !== this.viewport) {
			this.viewport = viewport;
			this.buildList(this.list.getSelectedItem()?.value);
		}
		// Below the frame's minimum size, keep the native input/cursor usable.
		if (width < 16 || height < 8) return [
			...this.input.render(Math.max(1, width)),
			...this.list.render(Math.max(4, width)).map((line) => this.theme.fg(line.startsWith("▶ ") ? "warning" : "text", line)),
		].slice(0, height).map((line) => truncateToWidth(line, Math.max(0, width), ""));

		// Match session-finder.ts: heavy border, two-cell padding and warning selection.
		const border = (value: string) => this.theme.fg("border", value);
		const inner = width - 2;
		const bodyWidth = inner - 4;
		const title = truncateToWidth(` Session Trash · ${this.filtered.length} results `, inner - 1, "…");
		const row = (value: string, color: "text" | "warning" | "dim" = "text") => {
			const fitted = truncateToWidth(value, bodyWidth, "…");
			const padded = `  ${fitted}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(fitted)))}  `;
			return border("┃") + this.theme.fg(color, padded) + border("┃");
		};
		const lines = [border(`┏${title}${"━".repeat(Math.max(0, inner - visibleWidth(title)))}┓`)];
		for (const line of this.input.render(bodyWidth - 8)) lines.push(row(`Search: ${line}`, "warning"));
		const items = this.list.render(bodyWidth);
		while (items.length < viewport + 1) items.push("");
		for (const item of items) lines.push(row(item, item.startsWith("▶ ") ? "warning" : "text"));
		lines.push(row("↑↓ / PgUp/PgDn navigate · type to search · Enter restore · Esc close", "dim"));
		lines.push(border(`┗${"━".repeat(inner)}┛`));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}
}
