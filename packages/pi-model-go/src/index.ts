// /model-go: a cost-aware alternative to the built-in /model, ported from rizal72/oc-models-pro.
// Rows come from Pi's own model registry (prices, context); the Go plan credit multiplier and the
// stencil.so intelligence score are decoration (lib/model-go.ts). Enter switches via pi.setModel.
// tok/s is not ported: Pi session entries carry no first/last streamed-token timestamps.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DIALOG_OVERLAY, dialogRows, wheelAsArrows } from "./lib/dialog.ts";
import { GO_PROVIDER, SORTS, compare, effective, loadBench, loadGoCredits, matches, toRow, type Row, type SortKey } from "./lib/model-go.ts";

type Scope = "go" | "ready" | "all";
const SCOPES: Scope[] = ["go", "ready", "all"];
const SCOPE_LABEL: Record<Scope, string> = { go: "OpenCode Go", ready: "with key", all: "all" };
const SORT_LABEL: Record<SortKey, string> = { effective: "effective ↑", input: "input ↑", output: "output ↑", context: "context ↓", int: "intelligence ↓", name: "name" };
const PAD_X = 2; // spaces between the border and the content
const GAP = 2; // spaces between columns
// Explicit bright white, bold: headers stand out on any dark theme.
const header = (s: string) => `\x1b[1m\x1b[97m${s}\x1b[39m\x1b[22m`;

const price = (n?: number) => (n === undefined ? "—" : n === 0 ? "free" : n < 10 ? n.toFixed(2) : n.toFixed(1));
const ctxText = (n?: number) => (n === undefined ? "—" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);
const pad = (s: string, w: number, right = false) => {
	const t = truncateToWidth(s, w, "…");
	const gap = " ".repeat(Math.max(0, w - visibleWidth(t)));
	return right ? gap + t : t + gap;
};

class Picker implements Component {
	private query = "";
	private scope: Scope;
	private sort: SortKey = "effective";
	private selected = 0;
	private offset = 0;
	private pageSize = 10;

	private tui: any;
	private theme: any;
	private all: Row[];
	private current: string | undefined;
	private notes: string[];
	private done: (row: Row | null) => void;

	constructor(tui: any, theme: any, all: Row[], current: string | undefined, notes: string[], done: (row: Row | null) => void, query: string) {
		this.tui = tui;
		this.theme = theme;
		this.all = all;
		this.current = current;
		this.notes = notes;
		this.done = done;
		this.query = query;
		this.scope = all.some((r) => r.provider === GO_PROVIDER) ? "go" : "all";
	}

	private list(): Row[] {
		return this.all
			.filter((r) => (this.scope === "go" ? r.provider === GO_PROVIDER : this.scope === "ready" ? r.hasAuth : true))
			.filter((r) => matches(r, this.query))
			.sort((a, b) => compare(this.sort, a, b));
	}

	render(width: number): string[] {
		const t = this.theme;
		const border = (s: string) => t.fg("border", s);
		const inner = Math.max(20, width - 2);
		const body = inner - 2 * PAD_X;
		const line = (s: string) => border("┃") + " ".repeat(PAD_X) + pad(s, body) + " ".repeat(PAD_X) + border("┃");
		const rows = this.list();
		// Everything except the table rows: 2 borders, 4 blank padding lines, search, header, detail, hint, notes.
		const chrome = 10 + (this.notes.length ? 1 : 0);
		this.pageSize = dialogRows(this.tui, chrome, 5);
		this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
		this.offset = Math.max(0, Math.min(this.offset, this.selected, rows.length - this.pageSize));
		if (this.selected >= this.offset + this.pageSize) this.offset = this.selected - this.pageSize + 1;

		// Fixed numeric columns; the name takes what is left and the widest-but-least-useful columns drop first.
		const cols = [
			{ key: "EFFECTIVE", w: 9, get: (r: Row) => price(effective(r)) },
			{ key: "INPUT", w: 6, get: (r: Row) => price(r.input) },
			{ key: "OUTPUT", w: 6, get: (r: Row) => price(r.output) },
			{ key: "CONTEXT", w: 7, get: (r: Row) => ctxText(r.context) },
			{ key: "INTELLIGENCE", w: 12, get: (r: Row) => (r.int === undefined ? "—" : r.int.toFixed(0)) },
			{ key: "CREDIT", w: 9, get: (r: Row) => (r.provider !== GO_PROVIDER ? "" : `${r.credit}x${r.promo ? "↑" : ""}${r.peak ? " pk" : ""}`) },
		];
		const nameMin = 22;
		const dropOrder = ["OUTPUT", "CREDIT", "INPUT", "CONTEXT", "INTELLIGENCE"];
		let shown = cols;
		const used = () => shown.reduce((s, c) => s + c.w + GAP, 0);
		for (const k of dropOrder) if (body - 2 - used() < nameMin) shown = shown.filter((c) => c.key !== k);
		const nameW = Math.max(8, body - 2 - used());
		const fmt = (mark: string, name: string, cells: string[]) => mark + " " + pad(name, nameW) + cells.map((c, i) => " ".repeat(GAP) + pad(c, shown[i].w, true)).join("");

		const title = ` /model-go · ${SCOPE_LABEL[this.scope]} · sorted by ${SORT_LABEL[this.sort]} · ${rows.length} models `;
		const out = [border(`┏${pad(title, inner).replace(/ +$/, (s) => "━".repeat(s.length))}┓`)];
		out.push(line(""));
		out.push(line(t.fg("warning", `Search: ${this.query}▏`)));
		out.push(line(""));
		out.push(line(header(fmt(" ", "MODEL", shown.map((c) => c.key)))));
		const page = rows.slice(this.offset, this.offset + this.pageSize);
		for (let i = 0; i < this.pageSize; i++) {
			const r = page[i];
			if (!r) { out.push(line("")); continue; }
			const id = `${r.provider}/${r.id}`;
			const isSel = this.offset + i === this.selected;
			const isCur = id === this.current;
			const label = r.provider === GO_PROVIDER && this.scope === "go" ? r.id : id;
			const text = fmt(isSel ? "▶" : isCur ? "●" : " ", label, shown.map((c) => c.get(r)));
			out.push(line(isSel ? t.fg("accent", text) : !r.hasAuth ? t.fg("dim", text) : isCur ? t.fg("success", text) : t.fg("text", text)));
		}
		const sel = rows[this.selected];
		out.push(line(""));
		const detail = sel && sel.provider === GO_PROVIDER
			? `${sel.name}: ${sel.credit}x plan credit${sel.promo ? ` (promo ${sel.promo}x)` : ""}${sel.peak ? `, peak price ${sel.peak}x` : ""}${sel.hasAuth ? "" : " · set OPENCODE_API_KEY to use"}`
			: sel ? `${sel.name}${sel.hasAuth ? "" : " · no API key configured"}` : "no match";
		out.push(line(t.fg("muted", detail)));
		if (this.notes.length) out.push(line(t.fg("warning", "⚠ " + this.notes.join(" · "))));
		out.push(line(t.fg("dim", "↑↓ move · Enter switch · ^O sort · ^S scope · ^U clear · Esc close · $/M tokens, effective = input ÷ credit")));
		out.push(line(""));
		out.push(border(`┗${"━".repeat(inner)}┛`));
		return out.map((l) => truncateToWidth(l, width));
	}

	handleMouse(event: TuiMouseEvent) { return wheelAsArrows(event, (key) => this.handleInput(key)); }

	handleInput(data: string): void {
		const rows = this.list();
		if (matchesKey(data, "escape")) {
			if (!this.query) return this.done(null);
			this.query = "";
		} else if (matchesKey(data, "ctrl+c")) return this.done(null);
		else if (matchesKey(data, "enter")) return rows[this.selected] ? this.done(rows[this.selected]) : undefined;
		else if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(rows.length - 1, this.selected + 1);
		else if (matchesKey(data, "pageUp")) this.selected = Math.max(0, this.selected - this.pageSize);
		else if (matchesKey(data, "pageDown")) this.selected = Math.min(rows.length - 1, this.selected + this.pageSize);
		else if (matchesKey(data, "ctrl+o")) this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length];
		else if (matchesKey(data, "ctrl+s")) { this.scope = SCOPES[(SCOPES.indexOf(this.scope) + 1) % SCOPES.length]; this.selected = 0; }
		else if (matchesKey(data, "ctrl+u")) { this.query = ""; this.selected = 0; }
		else if (matchesKey(data, "backspace")) { this.query = this.query.slice(0, -1); this.selected = 0; }
		else if (!/[\x00-\x1f\x7f]/.test(data)) { this.query += data; this.selected = 0; }
		this.tui.requestRender();
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("model-go", {
		description: "Model picker with price, context, intelligence and OpenCode Go plan credits",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("/model-go needs the interactive TUI; use /model", "warning");
			const [go, bench] = await Promise.all([loadGoCredits(), loadBench()]);
			const registry = ctx.modelRegistry;
			const rows = registry.getAll()
				.filter((m: any) => !m.type || m.type === "chat")
				.map((m) => toRow(m, registry.hasConfiguredAuth(m), go.credits, bench.bench));
			const notes = [go.error, bench.error].filter((e): e is string => !!e);
			if (!rows.some((r) => r.provider === GO_PROVIDER))
				notes.unshift("no opencode-go models in the registry: set OPENCODE_API_KEY (or /login) to list them");
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const picked = await ctx.ui.custom<Row | null>(
				(tui, theme, _kb, done) => new Picker(tui, theme, rows, current, notes, done, (args ?? "").trim()),
				DIALOG_OVERLAY,
			);
			if (!picked) return;
			const model = registry.find(picked.provider, picked.id);
			if (!model) return ctx.ui.notify(`Model ${picked.provider}/${picked.id} not found`, "error");
			if (!(await pi.setModel(model)))
				return ctx.ui.notify(`No API key for ${picked.provider}${picked.provider === GO_PROVIDER ? ": set OPENCODE_API_KEY or /login" : ""}`, "warning");
			ctx.ui.notify(`Model: ${picked.provider}/${picked.id}`, "info");
		},
	});
}
