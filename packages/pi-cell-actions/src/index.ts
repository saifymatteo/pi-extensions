/**
 * Cell actions: hover a block of a message (paragraph, list, heading, code block,
 * table) or a tool call in the fullscreen transcript for a ⋯ badge; click it for a menu that
 * copies the cell (tables as Markdown, TSV or CSV; tools as input or output) and
 * runs shell code blocks after a confirmation.
 *
 * Works on stock Pi and Pi-Bolt through APIs both share:
 * - hover: the three transcript component prototypes get a `handleMouse` wrapper
 *   that only observes events (location and bounds), never handles them;
 * - drawing: one non-capturing overlay, so no renderer or render cache is patched;
 * - the overlay counts as "visible" only between mouse events, so selection,
 *   scrollbars and wheel routing (which check `hasOverlay()`) behave as without it.
 * Regular (non-fullscreen) mode has no mouse events, so nothing shows there.
 */
import {
	AssistantMessageComponent,
	copyToClipboard,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isViewportTUI,
	matchesKey,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { locateBlocks, parseBlocks, RUNNABLE, toCsv, toTsv, type LocatedBlock } from "./cells.ts";

type Theme = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
};
type Action = { label: string; run: () => void | Promise<void>; primary?: boolean };
/** A hovered cell: its first screen row and its columns left..right-1. */
type Cell = { key: string; name: string; top: number; left: number; right: number; actions: () => Action[] };
type ToolLike = { toolCallId?: string; toolName?: string; args?: unknown; result?: { content?: unknown } };
type MouseHandler = (this: Component, event: TuiMouseEvent) => unknown;
type RawMouse = { button: number; x: number; y: number; release: boolean };
type LayoutBox = { clip: { y: number; height: number }; scrollView?: unknown; children: LayoutBox[] };
type MouseTui = TUI & {
	handleMouseEvent?(raw: RawMouse): void;
	routeWheel?(...args: unknown[]): unknown;
	currentLayout?: { root: LayoutBox };
	getPrimaryScrollView?(): unknown;
};

const RUN_TYPE = "cell-run";
const PATCHED = Symbol.for("pi-cell-actions.handleMouse");
/** Set by pi-compact-tools: the toolCallIds a group card draws, keyed by its head call. */
const TOOL_GROUP = Symbol.for("pi-cell-actions.toolGroup");
/** Set here, called by pi-compact-tools: which call of a group card the pointer is on. */
const TOOL_HOVER = Symbol.for("pi-cell-actions.toolHover");
type ToolHover = { head: string; id?: string; top?: number; height?: number };
const COPIED_MS = 1500;
const RUN_TIMEOUT_MS = 120_000;

const textOf = (content: unknown): string =>
	typeof content === "string" ? content
		: Array.isArray(content) ? content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n") : "";

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let tui: MouseTui | undefined;
	let theme: Theme | undefined;
	let handle: OverlayHandle | undefined;
	let hovered: Cell | undefined;
	let open = false;
	let copied: string | undefined;
	/** The button under the pointer: drawn as yellow text without its box, to show it is clickable. */
	let pressable: string | undefined;
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	// True while Pi handles a mouse event outside our overlay: hasOverlay() is then false.
	let suppressed = false;
	let sawCell = false;
	let toolHover: ToolHover | undefined;
	const restores: (() => void)[] = [];
	const layoutCache = new WeakMap<object, { width: number; lines: string[]; text: string; blocks: LocatedBlock[] }>();

	const options: OverlayOptions = { row: 0, col: 0, width: 3, nonCapturing: true, visible: () => !!hovered && !suppressed };
	let buttons: { start: number; end: number; action: Action }[] = [];

	function setHover(cell: Cell | undefined) {
		if (cell?.key === hovered?.key && cell?.top === hovered?.top && cell?.right === hovered?.right) {
			if (cell) hovered = cell;
			return;
		}
		hovered = cell;
		open = false;
		pressable = undefined;
		copied = undefined;
		tui?.requestRender();
	}

	function flash(label: string) {
		copied = label;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => {
			copied = undefined;
			place();
			tui?.requestRender();
		}, COPIED_MS);
		place(); // "✓ copied" can be wider than the label it replaces
		tui?.requestRender();
	}

	function copy(label: string, text: () => string): Action {
		return {
			label,
			run: async () => {
				try {
					await copyToClipboard(text());
					flash(label);
				} catch (error) {
					ctx?.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		};
	}

	async function runBlock(lang: string, code: string) {
		const shell = RUNNABLE[lang];
		const context = ctx;
		if (!shell || !context) return;
		setHover(undefined);
		if (!(await context.ui.confirm(`Run this ${lang} block?`, code))) return;
		const result = await pi.exec(shell, ["-c", code], { cwd: context.cwd, timeout: RUN_TIMEOUT_MS }).catch((error: unknown) => ({
			stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1, killed: false,
		}));
		const output = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n").trimEnd();
		const status = result.killed ? "timed out" : `exit ${result.code}`;
		pi.sendMessage({
			customType: RUN_TYPE,
			content: `Ran a ${lang} block from the chat (${status}):\n$ ${code}\n\n${output || "(no output)"}`,
			display: true,
			details: { lang, code, output, status, failed: result.killed || result.code !== 0 },
		}, { triggerTurn: false }); // never steer a running turn; the model sees it next turn
	}

	function blockActions(block: LocatedBlock): Action[] {
		if (block.kind === "text") return [{ ...copy("copy", () => block.markdown), primary: true }];
		if (block.kind === "table") {
			return [
				{ ...copy("copy markdown", () => block.markdown), primary: true },
				copy("copy TSV", () => toTsv(block.rows)),
				copy("copy CSV", () => toCsv(block.rows)),
			];
		}
		const actions: Action[] = [{ ...copy("copy", () => block.code), primary: true }];
		if (RUNNABLE[block.lang]) actions.push({ label: "run", run: () => runBlock(block.lang, block.code) });
		return actions;
	}

	/** Code blocks and tables of a message, with the rows they occupy. Cached per render. */
	function blocksOf(component: Component, width: number, text: string): LocatedBlock[] {
		// Pi-Bolt's render() returns a fresh copy each call, so compare by content, not identity.
		const lines = component.render(width);
		const cached = layoutCache.get(component);
		if (cached && cached.width === width && cached.text === text && cached.lines.length === lines.length &&
			cached.lines.every((line, i) => line === lines[i])) return cached.blocks;
		const blocks = locateBlocks(lines.map((line) => stripTerminalSequences(line)), parseBlocks(text));
		layoutCache.set(component, { width, lines, text, blocks });
		return blocks;
	}

	/** The first non-blank row from `top`, so the badge sits on the cell's text, not its padding. */
	function firstText(lines: string[], top: number): number {
		let row = top;
		while (row < lines.length - 1 && !stripTerminalSequences(lines[row] ?? "").trim()) row++;
		return row;
	}

	/** The block under the pointer: a paragraph, list, heading, code block or table. */
	function messageCell(component: Component, event: TuiMouseEvent, name: string, text: string): Cell | undefined {
		const top = event.screenY - event.y;
		const left = event.screenX - event.x;
		const right = left + event.width;
		const blocks = blocksOf(component, event.width, text);
		const block = blocks.find((b) => event.y >= b.top && event.y <= b.bottom);
		const lines = layoutCache.get(component)?.lines ?? [];
		if (block) {
			return { key: `${name}:${block.top}`, name: `${block.kind} cell`, top: top + firstText(lines, block.top), left, right, actions: () => blockActions(block) };
		}
		// Rows above the first block (padding, thinking) have no menu, unless no block
		// could be located at all: then the whole message is one cell.
		if (blocks.length) return undefined;
		return { key: name, name: `${name} cell`, top: top + firstText(lines, 0), left, right, actions: () => [{ ...copy("copy", () => text), primary: true }] };
	}

	function toolCalls(component: ToolLike): { id?: string; name: string; input: unknown; output: string }[] {
		const head = component.toolCallId;
		const members = (globalThis as Record<symbol, ((id: string) => string[] | undefined) | undefined>)[TOOL_GROUP]?.(head ?? "") ?? [head];
		const branch = (ctx?.sessionManager.getBranch() ?? []) as { type: string; message?: { role: string; content?: unknown; toolCallId?: string } }[];
		const calls = new Map<string, { name: string; input: unknown }>();
		const results = new Map<string, string>();
		for (const entry of branch) {
			const message = entry.type === "message" ? entry.message : undefined;
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) if (block?.type === "toolCall") calls.set(block.id, { name: block.name, input: block.arguments });
			} else if (message?.role === "toolResult" && message.toolCallId) {
				results.set(message.toolCallId, textOf(message.content));
			}
		}
		return members.flatMap((id) => {
			if (id === head) return [{ id, name: component.toolName ?? "tool", input: component.args, output: textOf(component.result?.content) }];
			const call = id ? calls.get(id) : undefined;
			return call ? [{ id, ...call, output: results.get(id!) ?? "" }] : [];
		});
	}

	/**
	 * A tool card. On a pi-compact-tools group, the header row is the whole group,
	 * and an expanded call's rows are that call, with the group's copies after its own.
	 */
	function toolCell(component: ToolLike, event: TuiMouseEvent): Cell {
		const top = event.screenY - event.y;
		const left = event.screenX - event.x;
		const right = left + event.width;
		type Call = { id?: string; name: string; input: unknown; output: string };
		const join = (pick: (call: Call) => string, only?: string) => () => {
			const calls = toolCalls(component).filter((call) => !only || call.id === only);
			return calls.length === 1 ? pick(calls[0]) : calls.map((call) => `# ${call.name}\n${pick(call)}`).join("\n\n");
		};
		const input = (call: Call) => JSON.stringify(call.input ?? {}, null, 2);
		const output = (call: Call) => call.output;
		const hover = toolHover?.head === component.toolCallId ? toolHover : undefined;
		if (hover?.id && hover.top !== undefined) {
			const id = hover.id;
			return {
				key: `tool:${component.toolCallId}:${id}`,
				name: "tool call",
				top: hover.top,
				left,
				right,
				actions: () => [
					copy("copy output", join(output, id)),
					{ ...copy("copy input", join(input, id)), primary: true },
					copy("all output", join(output)),
					copy("all input", join(input)),
				],
			};
		}
		return {
			key: `tool:${component.toolCallId}`,
			name: toolCalls(component).length > 1 ? "tool group" : "tool call",
			top: top + firstText((component as unknown as Component).render(event.width), 0),
			left,
			right,
			actions: () => [copy("copy output", join(output)), { ...copy("copy input", join(input)), primary: true }],
		};
	}

	/** Observe (never handle) mouse events on one transcript component class. */
	function observe(proto: { handleMouse?: MouseHandler } & Record<symbol, unknown>, cellAt: (component: any, event: TuiMouseEvent) => Cell | undefined) {
		if (proto[PATCHED]) return;
		const own = Object.hasOwn(proto, "handleMouse");
		const original = proto.handleMouse;
		let active = true;
		const wrapper: MouseHandler = function (event) {
			// Pi's handler first: a pi-compact-tools card reports the hovered call during it.
			const result = original?.call(this, event);
			if (active && (event.type === "move" || event.type === "press") && event.height > 0) {
				try {
					const cell = cellAt(this, event);
					if (cell) {
						sawCell = true;
						setHover(cell);
					}
				} catch {
					// Never break Pi's own mouse handling.
				}
			}
			return result;
		};
		proto.handleMouse = wrapper;
		proto[PATCHED] = true;
		restores.push(() => {
			active = false; // stays in place, inert, if another extension wrapped it since
			delete proto[PATCHED];
			if (proto.handleMouse !== wrapper) return;
			if (own) proto.handleMouse = original;
			else delete proto.handleMouse;
		});
	}

	/** The badge, or the open menu's button row and cell label, right-aligned to the wider one. */
	function menuLines(): string[] {
		const t = theme;
		buttons = [];
		if (!t || !hovered) return [];
		// Yellow boxes (inverted warning color): visible on any background, user messages included.
		const yellow = (text: string, bold = false) => t.inverse(t.fg("warning", bold ? t.bold(text) : text));
		if (!open) return [yellow(" ⋯ ", true)];
		// A leading space separates the menu from whatever it covers (a table border, a rule).
		let row = " ";
		let col = 1;
		for (const action of hovered.actions()) {
			const label = ` ${copied === action.label ? "✓ copied" : action.label} `;
			const w = visibleWidth(label);
			buttons.push({ start: col, end: col + w, action });
			row += (pressable === action.label ? t.fg("warning", t.bold(label)) : yellow(label, action.primary)) + " ";
			col += w + 1;
		}
		const lines = [row + t.fg("dim", "esc "), t.fg("dim", ` ─ ${hovered.name} ─ `)];
		// Shift here, not in render(): a mouse event between render and click rebuilds the buttons.
		const width = Math.max(...lines.map((line) => visibleWidth(line)));
		const shift = width - visibleWidth(lines[0]);
		for (const button of buttons) { button.start += shift; button.end += shift; }
		return lines.map((line) => " ".repeat(width - visibleWidth(line)) + line);
	}

	const overlay: Component = {
		render(width: number): string[] {
			// place() sized the box to the lines, so they fill it exactly.
			return menuLines().map((line) => truncateToWidth(line, width, ""));
		},
		handleMouse(event: TuiMouseEvent) {
			if (event.type === "move") {
				// Hovering the badge opens the menu; hovering a button dims it. Pi doesn't redraw for moves, so ask.
				const over = open && event.y === 0 ? buttons.find((b) => event.x >= b.start && event.x < b.end)?.action.label : undefined;
				if (!open || over !== pressable) { open = true; pressable = over; place(); tui?.requestRender(); }
				return { handled: true };
			}
			if (event.type !== "click" || event.button !== "left") return { handled: true, render: false };
			if (!open) {
				open = true;
				place();
				return { handled: true };
			}
			const hit = event.y === 0 ? buttons.find((b) => event.x >= b.start && event.x < b.end) : undefined;
			if (hit) void hit.action.run();
			else if (event.y === 0 && event.x >= (buttons.at(-1)?.end ?? 0)) open = false; // esc
			place();
			return { handled: true };
		},
		invalidate() {},
	};

	/** Overlay geometry follows the hovered cell; read by Pi on every render. */
	function place() {
		if (!hovered || !tui) return;
		const width = Math.max(1, ...menuLines().map((line) => visibleWidth(line)));
		options.width = width;
		options.col = Math.max(hovered.left, hovered.right - width - 1);
		// On the cell's first row; kept inside the transcript, off the editor.
		const view = transcriptRows();
		options.row = Math.max(view.top, Math.min(hovered.top, view.bottom - 1));
	}

	/** Screen rows of the scrolling transcript, so the menu never covers the editor or footer. */
	function transcriptRows(): { top: number; bottom: number } {
		const all = { top: 0, bottom: Number.MAX_SAFE_INTEGER };
		const scrollView = tui?.getPrimaryScrollView?.();
		const visit = (box: LayoutBox | undefined): LayoutBox | undefined =>
			!box ? undefined : box.scrollView === scrollView ? box : box.children?.map(visit).find(Boolean);
		const clip = scrollView ? visit(tui?.currentLayout?.root)?.clip : undefined;
		return clip ? { top: clip.y, bottom: clip.y + clip.height - 1 } : all;
	}

	function attach(next: TUI) {
		const target = next as MouseTui;
		if (tui === target || !isViewportTUI(next) || typeof target.handleMouseEvent !== "function") return;
		tui = target;
		const handleMouseEvent = target.handleMouseEvent!;
		const ownMouse = Object.hasOwn(target, "handleMouseEvent");
		const ownWheel = Object.hasOwn(target, "routeWheel");
		const mouseWrapper = function (this: MouseTui, raw: RawMouse) {
			const motion = (raw.button & 32) !== 0;
			const inside = (bounds?: { row: number; col: number; width: number; height: number }) =>
				!!bounds && raw.y >= bounds.row && raw.y < bounds.row + bounds.height && raw.x >= bounds.col && raw.x < bounds.col + bounds.width;
			const overOverlay = inside(handle?.getBounds?.());
			if (!overOverlay) pressable = undefined;
			suppressed = !overOverlay;
			sawCell = false;
			toolHover = undefined;
			try {
				return handleMouseEvent.call(this, raw);
			} finally {
				suppressed = false;
				const moved = motion && (raw.button & 3) === 3; // pointer motion with no button held
				if (moved && !overOverlay && !sawCell) setHover(undefined);
				place();
			}
		};
		target.handleMouseEvent = mouseWrapper;
		restores.push(() => {
			if (target.handleMouseEvent !== mouseWrapper) return;
			if (ownMouse) target.handleMouseEvent = handleMouseEvent;
			else delete (target as { handleMouseEvent?: unknown }).handleMouseEvent;
		});
		const routeWheel = target.routeWheel;
		if (typeof routeWheel === "function") {
			// Scrolling moves cells under a still pointer: drop the badge until the next move.
			const wheelWrapper = function (this: MouseTui, ...args: unknown[]) {
				setHover(undefined);
				return routeWheel.apply(this, args);
			};
			target.routeWheel = wheelWrapper;
			restores.push(() => {
				if (target.routeWheel !== wheelWrapper) return;
				if (ownWheel) target.routeWheel = routeWheel;
				else delete (target as { routeWheel?: unknown }).routeWheel;
			});
		}
		handle = next.showOverlay(overlay, options);
	}

	function detach() {
		if (copiedTimer) clearTimeout(copiedTimer);
		handle?.hide();
		handle = undefined;
		hovered = undefined;
		tui = undefined;
		for (const restore of restores.splice(0).reverse()) restore();
	}

	pi.registerMessageRenderer(RUN_TYPE, (message, { expanded }, t) => {
		const details = message.details as { lang?: string; code?: string; output?: string; status?: string; failed?: boolean } | undefined;
		const lines = (details?.output || "(no output)").split("\n");
		const shown = expanded ? lines : lines.slice(-12);
		const header = t.fg(details?.failed ? "error" : "success", t.bold("▶ ran")) + t.fg("dim", ` ${details?.lang ?? ""} block · ${details?.status ?? ""}`);
		const command = (details?.code ?? "").split("\n").map((line) => t.fg("bashMode", `$ ${line}`)).join("\n");
		const more = shown.length < lines.length ? `\n${t.fg("dim", `… ${lines.length - shown.length} earlier lines (Ctrl+O to expand)`)}` : "";
		return new Text(`${header}\n${command}\n${t.fg("toolOutput", shown.join("\n"))}${more}`, 1, 1);
	});

	pi.on("session_start", (_event, context) => {
		ctx = context;
		if (context.mode !== "tui") return;
		observe(UserMessageComponent.prototype as never, (component: { text?: string }, event) =>
			typeof component.text === "string" ? messageCell(component as never, event, "user", component.text) : undefined);
		observe(AssistantMessageComponent.prototype as never, (component: { lastMessage?: { content?: unknown } }, event) => {
			const content = component.lastMessage?.content;
			const text = Array.isArray(content)
				? content.filter((c) => c?.type === "text" && c.text?.trim()).map((c) => c.text.trim()).join("\n\n") : "";
			return text ? messageCell(component as never, event, "assistant", text) : undefined;
		});
		observe(ToolExecutionComponent.prototype as never, (component: ToolLike, event) => toolCell(component, event));
		const report = (hover: ToolHover) => { toolHover = hover; };
		(globalThis as Record<symbol, unknown>)[TOOL_HOVER] = report;
		restores.push(() => {
			if ((globalThis as Record<symbol, unknown>)[TOOL_HOVER] === report) delete (globalThis as Record<symbol, unknown>)[TOOL_HOVER];
		});
		// Esc closes an open menu; otherwise it reaches Pi untouched (abort, clear).
		restores.push(context.ui.onTerminalInput((data) => {
			if (!open || !matchesKey(data, "escape")) return undefined;
			open = false;
			place();
			tui?.requestRender();
			return { consume: true };
		}));
		// An empty widget: its factory is the public way to reach the TUI and theme.
		context.ui.setWidget("pi-cell-actions", (next, t) => {
			theme = t as Theme;
			attach(next);
			return { render: () => [], invalidate: () => {} };
		});
	});

	// New rows can scroll the transcript under a still pointer: drop a stale badge.
	const dropStale = () => { if (hovered && !open) setHover(undefined); };
	pi.on("message_start", dropStale);
	pi.on("tool_execution_start", dropStale);

	pi.on("session_shutdown", () => {
		detach();
		ctx = undefined;
	});
}
