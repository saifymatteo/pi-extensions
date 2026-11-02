// Compact Tools — consecutive tool calls share one warning-yellow card.
// The parent toggles child summary rows; a child's summary or plain output
// toggles that child's output. Interactive controls keep first refusal.
// ctrl+o (app.tools.expand) still expands/collapses everything. Child rows show
// tool-kind icons and explicit status; calls running for 1s stay visible even
// when the parent is folded. Custom renderers keep their styling and chips.
// Cards have no background fill. Parent-aligned Skills and failure rows follow
// the children and remain visible when folded. Running rows sit last at the same
// inset, with five live output lines; their full view opens independently.
// Image results have independent disclosure rows alongside tools, not nested
// inside tool output; parent folds
// retain each image's state. Image-only results replace their ordinary tool row.
// Reads of <skill>/SKILL.md do not count as ordinary files; nested reads use
// Pi's recorded call metadata.
//
// Grouping (pi 1.4): a row's renderers only see its own toolCallId, so groups
// are derived from the session branch plus the in-flight assistant message.
// A group is a run of tool calls with no user message, custom message or
// non-empty assistant text between them. The first call of a group (its
// head) draws the entire group card; the others render nothing. With
// renderShell: "self", a row whose components render zero lines takes zero
// lines — no spacer, no background box. Failed calls stay visible, one error
// line each, under the head.
//
// Thinking: pi draws it in AssistantMessageComponent, outside any tool
// renderer, so with hideThinkingBlock a "Thinking..." label would split every
// group. The prototype patch below drops thinking from assistant messages that
// are tool calls only (no text) — thinking is absorbed into the group. While
// the agent runs, the last group's line shows the latest thought instead.
// Messages with text keep their thinking; hideThinkingBlock: false (or the
// thinking toggle) shows it everywhere as before.
//
// Uses pi.registerToolRenderer(): renderers are attached to tools by name,
// while the tools themselves stay exactly as pi (or another extension)
// registered them. Execution is untouched; disabled tools are never
// resurrected (a renderer for a tool that never runs is inert), so no
// active-set check or session_start gating is needed — registration happens
// at plain load time.
//
// Covers the overridable built-ins (read, bash, powershell, edit, write,
// grep, find, ls), codemode, direct-exposure MCP tools, and — dynamically,
// without knowing names — every other tool whose definition lacks renderers.
//
// Codemode-exposure MCP tools never render as their own rows — they run as
// nested calls inside codemode scripts, covered by the codemode renderer.
// Direct-exposure MCP tools (name always starts with "mcp__") do render as
// their own rows; tool_search and any other built-in keeps its stock
// renderers.
//
// For every other tool (custom tools from other extensions), the resolver
// calls next() FIRST and keeps whatever renderers the chain or the registered
// definition provides for the expanded view — a tool that ships its own
// renderCall/renderResult is expanded inside the shared card, with its own
// colors and chips intact (grouping needs renderShell "self").
// Only the missing halves are filled in with compact ones. Because next()
// runs before the decision, later extensions' resolver entries still apply.
// Renderers are keyed by name: if another extension registers its own
// "bash", ours would render it too.

import { AssistantMessageComponent, ToolExecutionComponent, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, getCellDimensions, getImageDimensions, Image, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "os";

const TUI_CONTEXT = Symbol.for("compact-tools.tuiContext");
const OWN_IMAGES = Symbol.for("compact-tools.ownsImages");

type RenderArgs = Record<string, any>;
type RenderOptions = { expanded: boolean; isPartial: boolean };
type RenderTheme = any;
// The subset of pi's ToolRenderContext this file reads.
type RenderContext = {
	expanded?: boolean;
	toolCallId?: string;
	invalidate?: () => void;
	isError?: boolean;
	outputPad?: number;
	isPartial?: boolean;
	executionStarted?: boolean;
	showImages?: boolean;
	lastComponent?: CallComponent;
	[TUI_CONTEXT]?: boolean;
};
// Duck-typed pi-tui Component — pi adds renderCall's return value to a
// Container, so anything with render(width): string[] works.
// invalidate is required: pi wraps rows in a MouseRegion that calls
// child.invalidate() unconditionally.
type CallComponent = { render(width: number): string[]; invalidate(): void; setPaddingX?(paddingX: number): void; handleMouse?(event: any): any };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ImageState = { source: ImageBlock; open: boolean; dimensions: ReturnType<typeof getImageDimensions>; preview?: Image; maxWidth?: number; theme?: RenderTheme; view?: CallComponent };
type RenderResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean; details?: unknown };

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function firstText(result: RenderResult): string | null {
	const c = result.content.find((c) => c.type === "text" && c.text);
	if (c?.type !== "text") return null;
	return c.text ?? null;
}

// All text blocks joined. codemode splits its result across blocks — the
// header is one block, the script output follows in later blocks — so it must
// read them all; firstText would only ever see the header.
function allText(result: RenderResult): string {
	return result.content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => (c as { text: string }).text)
		.join("\n");
}

function fullOutput(text: string, theme: RenderTheme): Text {
	const output = text
		.trim()
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	return output ? new Text(`\n${output}`, 0, 0) : new Text("", 0, 0);
}

// --- renderers --------------------------------------------------------------

// Collapsed cap for shell call lines: at most this many visual (wrapped) lines.
const MAX_SHELL_CALL_LINES = 1;

// A call line that word-wraps like Text but, when collapsed, never exceeds
// MAX_SHELL_CALL_LINES visual lines: the overflow is cut off at terminal width
// with a dim hint naming the hidden line count, spliced into the last kept
// line. No character cap — the cap is
// measured in rendered lines, so it adapts to terminal width. Caches per width,
// since it renders on every frame.
class ShellCallLine {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private text: string;
	private theme: RenderTheme;
	private paddingX = 0;
	hasMore = false;

	constructor(text: string, theme: RenderTheme) {
		this.text = text;
		this.theme = theme;
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines === undefined || this.cachedWidth !== width) {
			const lines = new Text(this.text, this.paddingX, 0).render(width);
			this.hasMore = lines.length > MAX_SHELL_CALL_LINES;
			if (lines.length <= MAX_SHELL_CALL_LINES) {
				this.cachedLines = lines;
			} else {
				const hidden = lines.length - MAX_SHELL_CALL_LINES;
				const hint = this.theme.fg("dim", ` … (+${hidden} more line${hidden === 1 ? "" : "s"})`);
				// Text pads every line to full width; trim that padding before
				// splicing the hint into the last kept line.
				const kept = lines.slice(0, MAX_SHELL_CALL_LINES);
				const last = kept[kept.length - 1].replace(/\s+$/, "");
				const avail = Math.max(0, width - visibleWidth(hint));
				kept[kept.length - 1] =
					avail > 0 ? truncateToWidth(last, avail, "") + hint : truncateToWidth(last, width, "…");
				this.cachedLines = kept;
			}
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// bash / powershell share everything except the prompt prefix. The full
// command always renders (word-wrapped by the TUI); when collapsed it is
// capped at MAX_SHELL_CALL_LINES visual lines instead of being truncated at a
// fixed character count, and ctrl+o shows it without the cap.
function shellRenderCall(prompt: string) {
	return (args: RenderArgs, theme: RenderTheme, context: RenderContext): Text | ShellCallLine => {
		const cmd = args.command ?? "...";
		const text = theme.fg("toolTitle", theme.bold(`${prompt}${cmd}`));
		if (context.expanded) return new Text(text, 0, 0);
		return new ShellCallLine(text, theme);
	};
}

function shellRenderResult(result: RenderResult, { expanded, isPartial }: RenderOptions, theme: RenderTheme, _context: unknown): Text {
	if (isPartial && !expanded) return new Text("", 0, 0);

	const text = firstText(result) ?? "";
	const exitMatch = text.match(/exit code: (\d+)/);
	const failed = result.isError || (exitMatch !== null && exitMatch[1] !== "0");

	// Non-zero exit: always show the error line.
	if (failed) {
		const firstLine = text.trim().split("\n").find((l) => l.trim()) ?? `exit code: ${exitMatch?.[1]}`;
		return new Text(theme.fg("error", firstLine.slice(0, 200)), 0, 0);
	}

	if (!expanded) return new Text("", 0, 0);
	return fullOutput(text, theme);
}

function readRenderCall(args: RenderArgs, theme: RenderTheme, _context: unknown): Text {
	const path = args.path ? shortenPath(args.path) : "...";
	let text = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path)}`;
	if (args.offset !== undefined || args.limit !== undefined) {
		const start = args.offset ?? 1;
		const range = args.limit !== undefined ? `${start}-${start + args.limit - 1}` : `${start}-`;
		text += theme.fg("dim", `:${range}`);
	}
	return new Text(text, 0, 0);
}

function readRenderResult(result: RenderResult, { expanded, isPartial }: RenderOptions, theme: RenderTheme, _context: unknown): Text {
	if (isPartial && !expanded) return new Text("", 0, 0);

	const text = firstText(result);
	// Image blocks are handled by the common per-image disclosure layer.
	if (text === null) return new Text("", 0, 0);

	// Errors stay visible even collapsed.
	if (result.isError || text.startsWith("Error")) {
		return new Text(theme.fg("error", text.split("\n")[0]), 0, 0);
	}

	if (!expanded) return new Text("", 0, 0);
	return fullOutput(text, theme);
}

function pathRenderCall(name: string) {
	return (args: RenderArgs, theme: RenderTheme, _context: unknown): Text => {
		const path = args.path ? shortenPath(args.path) : ".";
		return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", path)}`, 0, 0);
	};
}

function writeRenderCall(args: RenderArgs, theme: RenderTheme, _context: unknown): Text {
	const path = args.path ? shortenPath(args.path) : "...";
	const lineCount = typeof args.content === "string" ? args.content.split("\n").length : 0;
	const info = lineCount > 0 ? theme.fg("dim", ` (${lineCount} lines)`) : "";
	return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path)}${info}`, 0, 0);
}

function grepRenderCall(args: RenderArgs, theme: RenderTheme, _context: unknown): Text {
	const path = args.path ? shortenPath(args.path) : ".";
	let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", String(args.pattern ?? ""))}`;
	if (args.glob) text += theme.fg("dim", ` (${args.glob})`);
	text += theme.fg("dim", ` in ${path}`);
	return new Text(text, 0, 0);
}

function findRenderCall(args: RenderArgs, theme: RenderTheme, _context: unknown): Text {
	const path = args.path ? shortenPath(args.path) : ".";
	return new Text(
		`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", String(args.pattern ?? ""))}${theme.fg("dim", ` in ${path}`)}`,
		0,
		0,
	);
}

// --- codemode ---------------------------------------------------------------

// The "Script completed\nWall time ...\nOutput:\n" header the tool prepends.
const CODEMODE_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function codemodeRenderCall(args: RenderArgs, theme: RenderTheme, _context: unknown): Text {
	const code = typeof args.code === "string" ? args.code : "";
	const firstLine = code
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l && !l.startsWith("//")) ?? "...";
	const shown = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
	return new Text(`${theme.fg("toolTitle", theme.bold("codemode"))} ${theme.fg("accent", shown)}`, 0, 0);
}

// Nested call records as pi actually builds them: { id, name, args, status,
// durationMs?, error?, cost? } — args is a JSON preview string pi truncates at
// 200 chars (ARGS_PREVIEW_CHARS); status is "running" | "ok" | "error" |
// "cancelled", with "running" only ever seen in partial updates.
type CodemodeCall = { name: string; args?: string; status?: string };

function codemodeRenderResult(result: RenderResult, { expanded, isPartial }: RenderOptions, theme: RenderTheme, _context: unknown): Text {
	const calls = ((result.details as { calls?: CodemodeCall[] } | undefined)?.calls) ?? [];

	// While the script runs, one dim line of live progress: calls so far and the
	// latest nested call (the stock renderer streams every call; that is not
	// compact).
	if (isPartial && !expanded) {
		if (calls.length === 0) return new Text("", 0, 0);
		const last = calls[calls.length - 1];
		return new Text(theme.fg("dim", `(${calls.length} calls… ${last.name})`), 0, 0);
	}

	const text = allText(result);
	const body = text.replace(CODEMODE_HEADER, "");

	// Failed scripts always show their error line, even collapsed.
	if (result.isError || text.startsWith("Script failed")) {
		const lines = body.split("\n");
		const firstLine = lines.find((l) => l.startsWith("Script error:")) ?? lines.find((l) => l.trim()) ?? "Script failed";
		return new Text(theme.fg("error", firstLine.slice(0, 200)), 0, 0);
	}

	// Collapsed: one dim line naming the nested calls; nothing when the script
	// called no tools.
	if (!expanded) {
		if (calls.length === 0) return new Text("", 0, 0);
		const label = calls.length === 1 ? "nested call" : "nested calls";
		return new Text(theme.fg("dim", `(${calls.length} ${label})`), 0, 0);
	}

	// Expanded: nested calls with status icons, then the script output.
	const lines = calls.map((call) => {
		const icon =
			call.status === "error"
				? theme.fg("error", "\uea6c") // nf-cod-warning
				: call.status === "cancelled"
					? theme.fg("muted", "\udb81\udf3a") // nf-md-cancel
					: call.status === "running"
						? theme.fg("muted", "\udb82\udd96") // nf-md-progress_clock
						: theme.fg("success", "\uf00c"); // nf-fa-check
		const argsText = call.args ?? "";
		const shownArgs = argsText.length > 120 ? `${argsText.slice(0, 117)}...` : argsText;
		return `${icon} ${theme.fg("toolTitle", call.name)} ${theme.fg("dim", shownArgs)}`;
	});
	const output = body.trim();
	if (output) lines.push(...output.split("\n").map((l) => theme.fg("toolOutput", l)));
	return lines.length > 0 ? new Text(`\n${lines.join("\n")}`, 0, 0) : new Text("", 0, 0);
}

// grep / find / ls: identical result rendering.
function simpleRenderResult(result: RenderResult, { expanded, isPartial }: RenderOptions, theme: RenderTheme, _context: unknown): Text {
	if (isPartial && !expanded) return new Text("", 0, 0);

	const text = firstText(result) ?? "";
	if (result.isError) {
		return new Text(theme.fg("error", text.split("\n")[0]), 0, 0);
	}

	if (!expanded) return new Text("", 0, 0);
	return fullOutput(text, theme);
}

function writeRenderResult(result: RenderResult, { expanded, isPartial }: RenderOptions, theme: RenderTheme, _context: unknown): Text {
	if (isPartial && !expanded) return new Text("", 0, 0);

	const text = firstText(result) ?? "";
	if (result.isError || text.startsWith("Error")) {
		return new Text(theme.fg("error", text.split("\n")[0]), 0, 0);
	}

	if (!expanded) return new Text("", 0, 0);
	return fullOutput(text, theme);
}

function editRenderResult(result: RenderResult, { expanded, isPartial }: RenderOptions, theme: RenderTheme, _context: unknown): Text {
	if (isPartial && !expanded) return new Text("", 0, 0);

	const text = firstText(result) ?? "";
	if (result.isError || text.startsWith("Error")) {
		return new Text(theme.fg("error", text.split("\n")[0]), 0, 0);
	}

	if (!expanded) return new Text("", 0, 0);

	// Prefer the diff from details when available.
	const details = result.details as { diff?: string } | undefined;
	if (details?.diff) {
		return fullOutput(details.diff, theme);
	}
	return fullOutput(text, theme);
}

// Fallback call line for tools with no registered definition or no renderCall
// of their own: bold label plus a truncated one-line JSON arg preview.
function argPreviewCall(label: string) {
	return (args: RenderArgs, theme: RenderTheme, _context: unknown): Text => {
		const shownArgs = JSON.stringify(args) ?? "";
		const shown = shownArgs.length > 120 ? `${shownArgs.slice(0, 117)}...` : shownArgs;
		return new Text(`${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("dim", shown)}`, 0, 0);
	};
}

// MCP tool names are mangled (`mcp__<server>__<tool>`, non-alphanumerics
// replaced with "_"); show them as server/tool.
function mcpRenderCall(name: string) {
	return argPreviewCall(name.replace(/^mcp__/, "").replace(/__/g, "/"));
}

// One entry per tool whose rendering compact-tools overrides. Add future
// built-ins here (nothing else to register — no factory, no execution shim).
interface CompactRenderers {
	renderCall(args: RenderArgs, theme: RenderTheme, context: RenderContext): Text | CallComponent;
	renderResult(result: RenderResult, options: RenderOptions, theme: RenderTheme, context: unknown): Text;
}

const compactRenderers: Record<string, CompactRenderers> = {
	read: { renderCall: readRenderCall, renderResult: readRenderResult },
	bash: { renderCall: shellRenderCall("$ "), renderResult: shellRenderResult },
	powershell: { renderCall: shellRenderCall("PS> "), renderResult: shellRenderResult },
	edit: { renderCall: pathRenderCall("edit"), renderResult: editRenderResult },
	write: { renderCall: writeRenderCall, renderResult: writeRenderResult },
	grep: { renderCall: grepRenderCall, renderResult: simpleRenderResult },
	find: { renderCall: findRenderCall, renderResult: simpleRenderResult },
	ls: { renderCall: pathRenderCall("ls"), renderResult: simpleRenderResult },
	codemode: { renderCall: codemodeRenderCall, renderResult: codemodeRenderResult },
};

// --- grouping ---------------------------------------------------------------

type SkillCall = { name?: string; arguments?: RenderArgs; args?: string };
type SkillResult = { nestedCalls?: { calls?: SkillCall[] }; details?: unknown };
type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: RenderArgs };
type Msg = SkillResult & { role: string; content?: unknown; toolCallId?: string; toolName?: string };
type GroupCall = { id: string; name: string; skill?: boolean; images?: number; hasText?: boolean };
type Group = { head: string; calls: GroupCall[]; members: string[]; skills: string[] };

function imageBlocks(content: unknown): ImageBlock[] {
	return Array.isArray(content) ? content.filter((block): block is ImageBlock =>
		block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") : [];
}

function skillName(name: string | undefined, args: RenderArgs | undefined): string | undefined {
	if (name !== "read" || typeof args?.path !== "string") return undefined;
	return args.path.replace(/\\/g, "/").match(/(?:^|\/)([^/]+)\/SKILL\.md$/i)?.[1];
}

// Full arguments are persisted on toolResult.nestedCalls. During codemode's
// live updates only details.calls and its JSON previews may be available.
function nestedSkills(result: SkillResult, toolName: string | undefined): string[] {
	const recorded = result.nestedCalls?.calls;
	// Other tools own their details schema; only codemode defines these previews.
	const previews = toolName === "codemode" ? (result.details as { calls?: SkillCall[] } | undefined)?.calls : undefined;
	const calls = [...(Array.isArray(recorded) ? recorded : []), ...(Array.isArray(previews) ? previews : [])];
	return calls.flatMap((call) => {
		if (call?.name !== "read") return [];
		let args = call.arguments;
		if (!args && typeof call.args === "string") {
			try { args = JSON.parse(call.args); }
			catch { return []; } // A truncated preview is not reliable metadata.
		}
		const name = skillName(call.name, args);
		return name ? [name] : [];
	});
}

// Pure: walk messages in chat order, assigning each tool call to a group.
// Anything visible between two calls (user/custom message, assistant text)
// starts a new group; tool results and thinking do not. A call seen twice
// (the in-flight copy of an already persisted message) keeps its first group.
function buildGroups(messages: Msg[]): { groupOf: Map<string, Group>; last?: Group } {
	const groupOf = new Map<string, Group>();
	let current: Group | undefined;
	let last: Group | undefined;
	for (const m of messages) {
		if (m.role === "toolResult") {
			const group = m.toolCallId ? groupOf.get(m.toolCallId) : undefined;
			if (group) {
				group.skills.push(...nestedSkills(m, m.toolName));
				const call = group.calls.find((call) => call.id === m.toolCallId);
				if (call) {
					call.images = imageBlocks(m.content).length;
					call.hasText = Array.isArray(m.content) && m.content.some((block) => block?.type === "text" && block.text?.trim());
				}
			}
			continue;
		}
		if (m.role !== "assistant" || !Array.isArray(m.content)) {
			current = undefined;
			continue;
		}
		for (const c of m.content as Block[]) {
			if (c.type === "text" && c.text?.trim()) current = undefined;
			if (c.type !== "toolCall" || !c.id || groupOf.has(c.id)) continue;
			current ??= { head: c.id, calls: [], members: [], skills: [] };
			const skill = skillName(c.name, c.arguments);
			if (skill) current.skills.push(skill);
			current.calls.push({ id: c.id, name: c.name ?? "tool", skill: !!skill });
			current.members.push(c.id);
			groupOf.set(c.id, current);
			last = current;
		}
	}
	return { groupOf, last };
}

// [verb, singular, plural]; tools sharing verb+noun are counted together.
const GROUP_LABELS: Record<string, [string, string, string]> = {
	read: ["read", "file", "files"],
	bash: ["ran", "command", "commands"],
	powershell: ["ran", "command", "commands"],
	edit: ["edited", "file", "files"],
	write: ["wrote", "file", "files"],
	grep: ["searched", "pattern", "patterns"],
	find: ["searched", "pattern", "patterns"],
	ls: ["listed", "directory", "directories"],
	codemode: ["ran", "script", "scripts"],
};
const OTHER_LABEL: [string, string, string] = ["called", "tool", "tools"];

function summarize(names: string[], images = 0): string {
	const counts = new Map<string, { label: [string, string, string]; n: number }>();
	for (const name of names) {
		const label = GROUP_LABELS[name] ?? OTHER_LABEL;
		const entry = counts.get(label.join()) ?? counts.set(label.join(), { label, n: 0 }).get(label.join())!;
		entry.n++;
	}
	const parts = [...counts.values()].map(({ label: [verb, one, many], n }) => `${verb} ${n} ${n === 1 ? one : many}`);
	if (images) parts.push(`viewed ${images} ${images === 1 ? "image" : "images"}`);
	const text = parts.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

// Group lines and hidden rows are opaque (no `text` field): bg-bash's badge
// resolver wraps ours and prefixes any call component exposing `text`, which
// must only hit real per-call lines. A hidden row renders zero lines; with
// renderShell "self" the whole row then disappears.
function opaque(text: string, paddingX: number): CallComponent {
	const inner = new Text(text, paddingX, 0);
	return { render: (width) => inner.render(width), invalidate: () => inner.invalidate() };
}

// A card is rendered by the head only: Pi inserts a blank line before every
// non-empty tool row, so framing individual rows would leave gaps in the card.
function card(getSections: () => CallComponent[][], theme: RenderTheme, padding: number): CallComponent {
	let sections: {
		content: CallComponent[]; box: Box; padding: number;
		width?: number; edge?: string; rendered?: string[]; lines?: string[];
	}[] = [];
	let layout: { box: Box; y: number; height: number }[] = [];
	let output: { frame: string; lines: string[] } | undefined;
	let inset = 0;
	let inner = 0;
	const border = (line: string) => theme.fg("warning", line);
	return {
		render(width) {
			if (width < 1) { output = undefined; layout = []; return []; }
			inset = width < 4 ? 0 : 1;
			inner = width - inset * 2;
			const rule = (left: string, right: string) => border(left + "─".repeat(inner) + right);
			const edge = inset ? border("│") : "";
			const rules = inset ? [rule("╭", "╮"), rule("├", "┤"), rule("╰", "╯")] : ["", "", ""];
			const frame = edge + rules.join("");
			const paddingX = Math.min(padding, Math.floor((inner - 1) / 2));
			const content = getSections();
			let changed = output?.frame !== frame || content.length !== sections.length;
			sections = content.map((content, i) => {
				const previous = sections[i];
				if (previous && previous.content.length === content.length && content.every((child, j) => child === previous.content[j])) return previous;
				const box = new Box(paddingX, 0);
				for (const child of content) box.addChild(child);
				return { content, box, padding: paddingX };
			});
			for (const section of sections) {
				const { box } = section;
				// Pi's setter invalidates its cache even when the padding is unchanged.
				if (section.padding !== paddingX) {
					box.setPaddingX(paddingX);
					section.padding = paddingX;
				}
				// Poll children every frame: custom components can change without a
				// renderer callback. Reuse only the expensive fitting of equal output.
				const rendered = box.render(inner);
				if (!section.lines || section.width !== inner || section.edge !== edge ||
					section.rendered?.length !== rendered.length || rendered.some((line, i) => line !== section.rendered![i])) {
					section.width = inner;
					section.edge = edge;
					section.rendered = rendered;
					// Image protocol payloads/row markers must not pass through text fitting.
					section.lines = rendered.map((line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=")
						? line : edge + truncateToWidth(line, inner, "", true) + edge);
					changed = true;
				}
			}
			// Only reuse the whole frame after polling all children above.
			if (!changed) return output!.lines;
			layout = [];
			const lines = inset ? [rules[0]] : [];
			for (const { box, lines: fitted } of sections) {
				if (!fitted?.length) continue;
				if (layout.length && inset) lines.push(rules[1]);
				layout.push({ box, y: lines.length, height: fitted.length });
				for (const line of fitted) lines.push(line);
			}
			if (inset) lines.push(rules[2]);
			output = { frame, lines };
			return lines;
		},
		handleMouse(event) {
			if (event.x < inset || event.x >= inner + inset) return undefined;
			const section = layout.find(({ y, height }) => event.y >= y && event.y < y + height);
			return section?.box.handleMouse({ ...event, x: event.x - inset, y: event.y - section.y, width: inner, height: section.height });
		},
		// groupCard owns child invalidation, including currently hidden rows.
		invalidate() { sections = []; layout = []; output = undefined; },
	};
}

// bg-bash's outer resolver badges `text` after renderCall returns. Forward
// that mutation to the inner call, never to the card's summary or border.
function badgeTarget(wrapper: CallComponent, child: CallComponent | undefined): CallComponent {
	const target = child as { text?: string; setText?(text: string): void } | undefined;
	if (typeof target?.text === "string") {
		Object.defineProperty(wrapper, "text", {
			get: () => target.text,
			set: (text: string) => {
				if (target.setText) target.setText(text);
				else target.text = text;
				child!.invalidate();
			},
		});
	}
	return wrapper;
}

// First line of the newest thinking block, for the running group's line.
function latestThought(message: Msg | undefined): string | undefined {
	if (!Array.isArray(message?.content)) return undefined;
	const thinking = (message.content as Block[]).filter((c) => c.type === "thinking" && c.thinking?.trim()).pop();
	const line = thinking?.thinking?.split("\n").map((l) => l.replace(/[*_#`]/g, "").trim()).find(Boolean);
	return line && line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

// Drops thinking from tool-call-only assistant messages while thinking is
// hidden. lastMessage is restored so toggling thinking back on re-renders the
// original. Guarded: /reload must not wrap the method twice.
const PATCHED = Symbol.for("compact-tools.absorbThinking");
function absorbThinking(): void {
	const proto = AssistantMessageComponent.prototype as any;
	if (proto[PATCHED]) return;
	proto[PATCHED] = true;
	const original = proto.updateContent;
	proto.updateContent = function (this: any, message: { content: Block[] }, ...rest: unknown[]) {
		const toolOnly =
			this.hideThinkingBlock &&
			message.content.some((c) => c.type === "toolCall") &&
			!message.content.some((c) => c.type === "text" && c.text?.trim());
		if (!toolOnly) return original.call(this, message, ...rest);
		original.call(this, { ...message, content: message.content.filter((c) => c.type !== "thinking") }, ...rest);
		this.lastMessage = message;
	};
}

// HTML export shares the renderer API, but consumes calls/results separately.
// Mark actual transcript contexts so exports keep full per-tool output and do
// not touch the live card's state. Guarded like absorbThinking for /reload.
function markToolContexts(): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (!proto[TUI_CONTEXT] && typeof proto.getRenderContext === "function") {
		const original = proto.getRenderContext;
		proto.getRenderContext = function (...args: unknown[]) {
			return { ...original.apply(this, args), [TUI_CONTEXT]: true };
		};
		proto[TUI_CONTEXT] = true;
	}
	// Pi 1.4 appends images outside custom renderers, even with renderShell self.
	// Hide only that final render pass for our renderer. Keep native image setup
	// intact (including PNG transcoder initialization for JPEG/WebP on Kitty).
	// The setting and result/model content are never changed.
	if (!proto[OWN_IMAGES] && typeof proto.render === "function") {
		const original = proto.render;
		proto.render = function (...args: unknown[]) {
			if (!this.toolDefinition?.renderResult?.[OWN_IMAGES]) return original.apply(this, args);
			const images = this.imageComponents;
			this.imageComponents = [];
			try { return original.apply(this, args); }
			finally { this.imageComponents = images; }
		};
		proto[OWN_IMAGES] = true;
	}
}

export default function (pi: ExtensionAPI) {
	let retired = false;
	let sessionManager: ExtensionContext["sessionManager"] | undefined;
	let live: Msg | undefined; // in-flight assistant message, maybe not persisted yet
	let running = false;
	let cache: { key: string; groupOf: Map<string, Group>; last?: Group } | undefined;
	const invalidators = new Map<string, () => void>(); // toolCallId -> row redraw
	// Native expanded belongs to Ctrl+O; pointer disclosure is local to the card.
	const openHeads = new Set<string>();
	type Row = { call?: CallComponent; result?: CallComponent; resultView?: CallComponent; error?: CallComponent; summary?: CallComponent;
		isPartial?: boolean; isError?: boolean; skills?: string[]; nativeExpanded?: boolean; open?: boolean; canExpand?: boolean;
		executionStarted?: boolean; revealed?: boolean; timer?: ReturnType<typeof setTimeout>;
		makeResult?: () => CallComponent; resultDirty?: boolean; images?: ImageState[]; showImages?: boolean;
		args?: RenderArgs; toolName?: string; hasText?: boolean; customResult?: boolean };
	const rows = new Map<string, Row>();
	const pendingHeads = new Set<string>();
	// nf-fa-hourglass_*
	const activityFrames = ["\uf251", "\uf252", "\uf253"];
	let activityFrame = 0;
	let activityTimer: ReturnType<typeof setInterval> | undefined;

	function stopActivity() {
		if (activityTimer !== undefined) clearInterval(activityTimer);
		activityTimer = undefined;
		activityFrame = 0;
	}

	function syncActivity() {
		const head = running && !latestThought(live) ? groups().last?.head : undefined;
		if (!head || !invalidators.has(head)) { stopActivity(); return; }
		if (activityTimer !== undefined) return;
		// One timer for the current parent, never one per row or historical card.
		activityTimer = setInterval(() => {
			syncActivity();
			if (activityTimer === undefined) return;
			activityFrame = (activityFrame + 1) % activityFrames.length;
			invalidators.get(groups().last!.head)?.();
		}, 160);
	}

	function rowState(id: string) {
		if (!rows.has(id)) rows.set(id, {});
		return rows.get(id)!;
	}

	function refreshHead(group: Group | undefined, id: string) {
		if (!group || group.head === id || pendingHeads.has(group.head)) return;
		pendingHeads.add(group.head);
		queueMicrotask(() => {
			if (pendingHeads.delete(group.head)) invalidators.get(group.head)?.();
		});
	}

	function syncExpanded(group: Group | undefined, id: string, context: RenderContext) {
		const state = rowState(id);
		const expanded = !!context.expanded;
		if (state.nativeExpanded !== expanded) {
			const first = state.nativeExpanded === undefined;
			state.nativeExpanded = expanded;
			for (const image of state.images ?? []) image.open = expanded;
			if (!first || state.open === undefined || expanded) state.open = expanded;
			if (!group || group.head === id) {
				if (expanded) openHeads.add(id);
				else openHeads.delete(id);
				for (const member of group?.members ?? []) rowState(member).open = expanded;
			}
		}
	}

	function updateTimer(id: string, state: Row) {
		if (!state.isPartial || !state.executionStarted) {
			if (state.timer !== undefined) clearTimeout(state.timer);
			state.timer = undefined;
			state.revealed = false;
		} else if (!state.revealed && state.timer === undefined) {
			state.timer = setTimeout(() => {
				state.timer = undefined;
				state.revealed = true;
				const head = groups().groupOf.get(id)?.head ?? id;
				invalidators.get(head)?.();
			}, 1000);
		}
	}

	function clearTimers() {
		for (const state of rows.values()) {
			if (state.timer !== undefined) clearTimeout(state.timer);
			state.timer = undefined;
		}
	}

	function groups() {
		const content = Array.isArray(live?.content) ? (live.content as Block[]) : [];
		const texts = content.filter((c) => c.type === "text" && c.text?.trim()).length;
		// A streaming read can acquire its skill path without adding a block.
		const paths = JSON.stringify(content.filter((c) => c.type === "toolCall" && c.name === "read").map((c) => c.arguments?.path));
		const key = `${sessionManager?.getSessionId()}:${sessionManager?.getLeafId()}:${content.length}:${texts}:${paths}`;
		if (cache?.key !== key) {
			const branch = sessionManager?.getBranch() ?? [];
			const messages = branch.flatMap((e: any) => (e.type === "message" ? [e.message as Msg] : []));
			cache = { key, ...buildGroups(live ? [...messages, live] : messages) };
		}
		return cache;
	}

	// Redraw the newest group's rows: its head line changes as calls join or
	// the agent stops, and rows drawn before their call was indexed regroup.
	function refresh() {
		syncActivity();
		for (const id of groups().last?.members ?? []) invalidators.get(id)?.();
	}

	absorbThinking();
	markToolContexts();

	pi.on("session_start", (_event, ctx) => {
		retired = false;
		running = false;
		stopActivity();
		clearTimers();
		sessionManager = ctx.sessionManager;
		live = undefined;
		cache = undefined;
		invalidators.clear();
		openHeads.clear();
		rows.clear();
		pendingHeads.clear();
	});
	pi.on("session_shutdown", () => {
		retired = true;
		sessionManager = undefined;
		live = undefined;
		cache = undefined;
		running = false;
		stopActivity();
		clearTimers();
		invalidators.clear();
		pendingHeads.clear();
	});
	pi.on("agent_start", () => {
		running = true;
		syncActivity();
	});
	pi.on("agent_end", () => {
		running = false;
		live = undefined;
		refresh();
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			live = event.message as Msg;
			syncActivity();
		} else refresh();
	});
	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		live = event.message as Msg;
		refresh();
	});

	function groupLine(group: Group, theme: RenderTheme, context: RenderContext): string {
		const names: string[] = [];
		let images = 0;
		for (const call of group.calls) {
			const state = rows.get(call.id);
			const count = state?.images?.length ?? call.images ?? 0;
			images += count;
			if (!call.skill && (!count || (call.name !== "read" && ((state?.hasText ?? call.hasText) || state?.customResult)))) names.push(call.name);
		}
		// nf-fa-caret_down and nf-fa-caret_right
		let text = theme.fg("warning", theme.bold(`${openHeads.has(group.head) ? "\uf0d7" : "\uf0da"} ${summarize(names, images) || "Skill instructions"}`));
		if (running && group === groups().last) {
			const thought = latestThought(live);
			// nf-md-thought_bubble_outline
			text += theme.fg("dim", thought ? ` \udb81\udff7 ${thought}` : ` ${activityFrames[activityFrame]}`);
		} else {
			text += theme.fg("dim", " (") + keyHint("app.tools.expand", context.expanded ? "to collapse" : "to expand") + theme.fg("dim", ")");
		}
		return text;
	}

	function disclosure(component: CallComponent, toggle: () => void): CallComponent {
		return {
			render: (width) => component.render(width),
			invalidate: () => component.invalidate(),
			handleMouse(event) {
				const handled = component.handleMouse?.(event);
				if (handled?.handled) return handled;
				if (event.type !== "click" || event.button !== "left") return handled;
				toggle();
				return { handled: true };
			},
		};
	}

	function statusLabel(state: Row): string {
		// nf-md-progress_clock for all unfinished calls (queued or executing)
		// nf-fa-check for success
		// nf-cod-warning for error
		return state.isPartial ? "\udb82\udd96 working" : state.isError ? "\uea6c error  " : "\uf00c success";
	}

	function toggleChild(id: string) {
		const state = rowState(id);
		if (isRunning(state) && state.canExpand === false) return;
		state.open = !state.open;
		if (state.open && state.makeResult) { state.result = state.makeResult(); state.resultDirty = false; }
		// Recreate this row's renderer with its new local expanded flag too
		// (custom chips, wrapped commands and bg-bash's outer badge resolver).
		invalidators.get(id)?.();
		refreshHead(groups().groupOf.get(id), id);
	}

	function isRunning(state: Row): boolean {
		return !!(state.isPartial && state.executionStarted);
	}

	function childPrefix(state: Row, open: boolean, glyph: string, theme: RenderTheme, canExpand = true): string {
		return theme.fg(state.isError ? "error" : state.isPartial ? "muted" : "success",
			`${isRunning(state) ? "" : " "}${canExpand ? open ? "\uf0d7" : "\uf0da" : " "} ${statusLabel(state)} `) + theme.fg("warning", `${glyph}  `);
	}

	function childSummary(id: string, toolName: string, theme: RenderTheme): CallComponent {
		const glyph = ({
			read: "\ueb1b", // nf-cod-mail_read
			bash: "\uf4b5", // nf-oct-command_palette
			powershell: "\uf4b5", // nf-oct-command_palette
			edit: "\uea73", // nf-cod-edit
			write: "\u{f0219}", // nf-md-file_document
			grep: "\u{f0451}", // nf-md-regex
			find: "\uf002", // nf-fa-magnifying_glass
			ls: "\uf00b", // nf-fa-table_list
			codemode: "\udb81\udc77", // nf-md-script_outline
		} as Record<string, string>)[toolName] ?? "\udb84\udc64"; // nf-md-tools
		// Render and hit-test the same prefix so icon spacing cannot shift clicks.
		// nf-fa-caret_down and nf-fa-caret_right
		const prefix = (state: Row, open: boolean) => childPrefix(state, open, glyph, theme, !isRunning(state) || state.canExpand !== false);
		const content: CallComponent = {
			render(width) {
				const state = rowState(id);
				const open = state.open && (isRunning(state) || openHeads.has(groups().groupOf.get(id)?.head ?? id));
				let chrome = prefix(state, !!open);
				const available = Math.max(1, width - visibleWidth(chrome));
				const lines = state.call?.render(available) ?? [toolName];
				if (isRunning(state)) {
					const output = state.result?.render(width) ?? [];
					// Ignore the renderer's leading spacer; keep disclosure for hidden
					// command lines too, even when the live output fits in five lines.
					state.canExpand = lines.length > 1 || (state.call instanceof ShellCallLine && state.call.hasMore)
						|| output.length - (output[0]?.trim() ? 0 : 1) > 5;
					chrome = prefix(state, !!open);
				}
				return (open ? lines : lines.slice(0, 1)).map((line, i) => (i ? " ".repeat(visibleWidth(chrome)) : chrome) + line);
			},
			handleMouse(event) {
				const state = rowState(id);
				const offset = visibleWidth(prefix(state, false));
				if (event.x < offset) return undefined;
				return state.call?.handleMouse?.({ ...event, x: event.x - offset, width: Math.max(1, event.width - offset) });
			},
			invalidate() {}, // the card invalidates the underlying retained call
		};
		return disclosure(content, () => toggleChild(id));
	}

	function imageRow(id: string, image: ImageState, index: number, theme: RenderTheme): CallComponent {
		return disclosure({
			render(width) {
				const state = rowState(id);
				const size = image.dimensions ? ` · ${image.dimensions.widthPx}×${image.dimensions.heightPx}` : "";
				const path = state.toolName === "read" && typeof state.args?.path === "string" ? shortenPath(state.args.path) : undefined;
				const label = path ? theme.fg("toolTitle", theme.bold("image")) + theme.fg("dim", ` ${path}${(state.images?.length ?? 0) > 1 ? ` · Image #${index + 1}` : ""}`)
					: theme.fg("toolTitle", theme.bold(state.toolName ?? "tool")) + theme.fg("dim", ` · Image #${index + 1}`);
				// nf-oct-image; same status chrome and inset as ordinary tool children.
				const lines = [truncateToWidth(childPrefix(state, image.open, "\uf4e5", theme) + label + theme.fg("dim", size), width, "…")];
				if (image.open) {
					// A read's image metadata belongs to its image row, not a second
					// file row. Preserve that text once when the first image is open.
					if (index === 0 && state.toolName === "read" && state.hasText) {
						if (state.resultDirty && state.makeResult) { state.result = state.makeResult(); state.resultDirty = false; }
						lines.push(...(state.result?.render(width) ?? []));
					}
					const natural = image.dimensions ? Math.max(1, Math.floor(image.dimensions.widthPx / getCellDimensions().widthPx)) : 60;
					const maxWidth = Math.min(natural, pi.getSettings().terminal?.imageWidthCells ?? natural);
					if (!image.preview || image.maxWidth !== maxWidth || image.theme !== theme) {
						image.maxWidth = maxWidth;
						image.theme = theme;
						image.preview = new Image(image.source.data, image.source.mimeType, { fallbackColor: (text: string) => theme.fg("dim", text) },
							{ maxWidthCells: maxWidth, maxHeightCells: Number.MAX_SAFE_INTEGER }, image.dimensions ?? undefined);
					}
					lines.push(...image.preview.render(width));
				}
				return lines;
			},
			invalidate() { image.preview?.invalidate(); },
		}, () => {
			image.open = !image.open;
			invalidators.get(id)?.();
			refreshHead(groups().groupOf.get(id), id);
		});
	}

	function groupCard(id: string, toolName: string, theme: RenderTheme, context: RenderContext): CallComponent {
		const summary = new Text("", 0, 0);
		const header = disclosure(summary, () => {
			if (openHeads.has(id)) openHeads.delete(id);
			else openHeads.add(id);
			invalidators.get(id)?.();
		});
		const skills = new Text("", 0, 0);
		let summaryText: string | undefined;
		let skillsText: string | undefined;
		const frame = card(() => {
			const group = groups().groupOf.get(id) ?? { head: id, calls: [{ id, name: toolName }], members: [id], skills: [] };
			const expanded = openHeads.has(group.head);
			const text = groupLine(group, theme, context);
			if (text !== summaryText) {
				summary.setText(text);
				summaryText = text;
			}
			const sections: CallComponent[][] = [[header]];
			const liveSections: CallComponent[][] = [];
			for (const member of group.members) {
				const state = rows.get(member);
				if (!state || (!expanded && !(isRunning(state) && state.revealed))) continue;
				const active = isRunning(state);
				const target = active ? liveSections : sections;
				const showImages = (state.images?.length ?? 0) > 0 && state.showImages !== false && pi.getSettings().terminal?.showImages !== false;
				// Image-only results need no intermediate tool disclosure. Keep mixed
				// text and custom controls on their own row, independent of the images.
				if (active || !showImages || ((state.hasText || state.customResult) && state.toolName !== "read") || state.isError) {
					if ((state.open || active) && state.resultDirty && state.makeResult) { state.result = state.makeResult(); state.resultDirty = false; }
					if (!state.resultView) {
						let offset = 0;
						let retainedSpacer = 0;
						state.resultView = disclosure({
							render(width) {
								const lines = state.result?.render(width) ?? [];
								// Tail five wrapped content lines, retaining the renderer's leading spacer.
								offset = isRunning(state) && !state.open ? Math.max(0, lines.length - 5) : 0;
								retainedSpacer = offset > 0 && !lines[0]?.trim() ? 1 : 0;
								return retainedSpacer ? [lines[0], ...lines.slice(offset)] : lines.slice(offset);
							},
							invalidate: () => state.result?.invalidate(),
							handleMouse: (event) => state.result?.handleMouse?.({ ...event,
								y: retainedSpacer && event.y === 0 ? 0 : event.y + offset - retainedSpacer,
								height: event.height + offset - retainedSpacer }),
						}, () => toggleChild(member));
					}
					const content = [state.summary, ...(active || (expanded && state.open) ? [state.resultView] : [])].filter((c): c is CallComponent => !!c);
					if (content.length) target.push(content);
				}
				if (expanded && showImages) for (const image of state.images ?? []) if (image.view) target.push([image.view]);
			}
			const names = [...new Set([...group.skills, ...group.members.flatMap((member) => rows.get(member)?.skills ?? [])])];
			if (names.length) {
				// nf-oct-light_bulb and nf-oct-dot_fill
				const label = theme.fg("warning", theme.bold("\uf400")) + " " + theme.fg("accent", theme.bold("Skills: ")) + names.map((name) => theme.fg("accent", name)).join(theme.fg("dim", " \ueb8a "));
				if (label !== skillsText) {
					skills.setText(label);
					skillsText = label;
				}
				sections.push([skills]);
			}
			for (const member of group.members) {
				const state = rows.get(member);
				// An explicitly opened child's output already contains its error.
				if (state?.error && !(state.open && expanded)) sections.push([state.error]);
			}
			sections.push(...liveSections);
			return sections;
		}, theme, context.outputPad ?? 1);
		return {
			// Old cards remain mounted briefly after /reload revokes their pi/ctx.
			render: (width) => retired ? [] : frame.render(width),
			handleMouse(event) {
				if (retired) return;
				const result = frame.handleMouse?.(event);
				return result?.handled ? result : event.type === "click" && event.button === "left" ? { handled: true } : result;
			},
			invalidate() {
				if (retired) return;
				frame.invalidate();
				summary.invalidate();
				skills.invalidate();
				const group = groups().groupOf.get(id);
				for (const member of group?.members ?? [id]) {
					rows.get(member)?.call?.invalidate();
					rows.get(member)?.result?.invalidate();
					for (const image of rows.get(member)?.images ?? []) image.view?.invalidate();
					rows.get(member)?.error?.invalidate();
				}
			},
		};
	}

	pi.registerToolRenderer((toolName, next) => {
		// Known names: fully owned renderers. Everything else — custom tools from
		// other extensions, direct-exposure MCP tools — keeps whatever renderers
		// exist (own, or from a later resolver via next()) and gets compact ones
		// only where the stock fallback would show full args / a 5-line preview.
		const own = Object.hasOwn(compactRenderers, toolName) ? compactRenderers[toolName] : undefined;
		const base = own
			? undefined
			: (next() as { renderCall?: CompactRenderers["renderCall"]; renderResult?: CompactRenderers["renderResult"] } | undefined);
		const renderCall =
			own?.renderCall ??
			base?.renderCall ??
			(toolName.startsWith("mcp__") ? mcpRenderCall(toolName) : argPreviewCall(toolName));
		const renderResult = own?.renderResult ?? base?.renderResult ?? simpleRenderResult;

		const renderers = {
			renderShell: "self" as const,
			renderCall: (args: RenderArgs, theme: RenderTheme, context: RenderContext) => {
				if (retired) return opaque("", 0);
				if (!context[TUI_CONTEXT]) return renderCall(args, theme, context);
				const id = context.toolCallId ?? "";
				if (context.invalidate) invalidators.set(id, context.invalidate);
				syncActivity();
				const group = groups().groupOf.get(id);
				syncExpanded(group, id, context);
				const state = rowState(id);
				state.args = args;
				state.toolName = toolName;
				const expanded = !!state.open;
				state.isPartial = context.isPartial ?? state.isPartial ?? true;
				state.executionStarted = context.executionStarted ?? state.executionStarted ?? false;
				updateTimer(id, state);
				state.isError = context.isError ?? state.isError;
				{
					const color = state.isPartial ? "muted" : state.isError ? "error" : undefined;
					// Override only the semantic title token; output, args, badges,
					// and successful titles keep their renderer's existing styling.
					const callTheme = color ? Object.assign(Object.create(theme), {
						fg: (token: string, text: string) => token === "toolTitle"
							? theme.fg(color, theme.bold(text)) : theme.fg(token, text),
					}) : theme;
					state.call = renderCall(args, callTheme, { ...context, expanded, outputPad: 0, lastComponent: state.call });
				}
				state.summary = childSummary(id, toolName, theme);
				refreshHead(group, id);
				const wrapper = !group || group.head === id ? groupCard(id, toolName, theme, context) : opaque("", 0);
				return badgeTarget(wrapper, state.call);
			},
			renderResult: (result: RenderResult, options: RenderOptions, theme: RenderTheme, context: RenderContext) => {
				if (retired) return opaque("", 0);
				if (!context[TUI_CONTEXT]) return renderResult(result, options, theme, context);
				const id = context.toolCallId ?? "";
				const group = groups().groupOf.get(id);
				syncExpanded(group, id, context);
				const state = rowState(id);
				state.isPartial = options.isPartial;
				state.executionStarted = context.executionStarted ?? state.executionStarted ?? false;
				updateTimer(id, state);
				state.isError = context.isError ?? result.isError;
				state.skills = nestedSkills(result, toolName);
				state.showImages = context.showImages;
				state.toolName = toolName;
				state.hasText = !!allText(result).trim();
				state.customResult = !!base?.renderResult;
				state.images = imageBlocks(result.content)
					.map((source, index) => {
						const previous = state.images?.[index];
						return previous?.source.data === source.data && previous.source.mimeType === source.mimeType ? previous
							: { source, open: !!context.expanded, dimensions: getImageDimensions(source.data, source.mimeType) };
					});
				state.images.forEach((image, index) => { image.view = imageRow(id, image, index, theme); });
				// Pi keeps isError on context, not on the result passed to renderers.
				state.makeResult = () => renderResult({ ...result, isError: state.isError }, { ...options, expanded: true }, theme,
					{ ...context, expanded: true, outputPad: 0, lastComponent: state.result });
				state.resultDirty = true;
				if (state.open) { state.result = state.makeResult(); state.resultDirty = false; }
				const line = (allText(result).trim().split("\n")[0] || "error").slice(0, 200);
				state.error = !options.isPartial && state.isError ? new Text(theme.fg("error", `\uea6c ${theme.bold(`${toolName}:`)} ${line}`), 0, 0) : undefined;
				refreshHead(group, id);
				return opaque("", 0);
			},
		};
		Object.defineProperty(renderers.renderResult, OWN_IMAGES, { value: true });
		return renderers;
	});
}
