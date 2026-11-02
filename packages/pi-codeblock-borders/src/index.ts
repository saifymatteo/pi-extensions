/**
 * Codeblock borders for pi.
 *
 * Renders markdown code fences as full-width rules spanning the content area
 * instead of the literal ``` markers, and upgrades the fence info string with
 * features pi's built-in renderer does not support:
 *
 *   bash── deploy.sh ────────────────────     ```bash title="deploy.sh"
 *     #!/usr/bin/env bash                      (title embedded in top rule)
 *   ────────────────────────────────────
 *
 *   ts──────────────────────────────────      ```ts:line-numbers
 *     1 │ const a = 1;                         (line numbers)
 *   ────────────────────────────────────
 *
 *   bash────────────────────────────────      ```bash {2,4-6}
 *     const a = 1;                             (lines 2, 4-6 highlighted;
 *       ...                                     the rest dimmed)
 *
 * Supported info-string syntax (all combinable, any order):
 *   lang            - first word: bash, ts, diff, ...
 *   :line-numbers   - prefix each code line with a dim line number;
 *                     optional start offset: :line-numbers=5
 *   {2,4-6}         - keep those lines at full color, dim the rest
 *   title="..."     - embed a title in the top rule (quotes optional for
 *                     single words; also title='...' and title=word)
 *
 * Why an info string like "bash {2,4-6}" degrades rendering without this
 * extension: marked keeps the FULL info string in token.lang, pi passes it to
 * highlight.js as the language name, which then fails to match and falls back
 * to unhighlighted code. This extension parses the info string itself and
 * feeds highlight.js only the leading language word, restoring highlighting.
 *
 * `diff` fences are natively supported by pi (+/- lines are colored via the
 * toolDiffAdded / toolDiffRemoved theme colors) and are left untouched.
 *
 * Implementation: wraps Markdown.prototype.renderToken from the bundled
 * @earendil-works/pi-tui, swapping theme.codeBlockBorder and
 * theme.highlightCode for the duration of each call. Widths come from the
 * actual render call, so rules and gutters size correctly in nested contexts
 * (blockquotes, list items). Caching, streaming, and theme colors are
 * untouched. Display-only: session content and LLM context keep the original
 * fences.
 *
 * Remove this file to restore the previous rendering, then run /reload or
 * restart pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";

/** Character used for the rule lines. Use "-" for plain ASCII dashes. */
const BORDER_CHAR = "─";

/**
 * Set to false for plain rules on fenced blocks too. When true, fenced blocks
 * with a language show it as a prefix of the top rule, e.g. `bash──────`.
 */
const SHOW_LANGUAGE = true;

/** Separator between the line number and the code in the gutter. */
const GUTTER_SEP = " │ ";

/** ANSI dim (SGR 2) used for gutter numbers and non-focused lines. */
const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

interface FenceInfo {
	/** Leading language word, e.g. "bash" from "bash:line-numbers {1}". */
	lang: string;
	/** Title from title="..." / title='...' / title=word, if present. */
	title?: string;
	/** :line-numbers flag present. */
	lineNumbers: boolean;
	/** Start value for line numbers (:line-numbers=5). */
	lineNumbersStart: number;
	/** Focus specification, resolved only after the highlighted line count is known. */
	focus?: string;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function dimText(text: string): string {
	// Re-assert dim after every ANSI reset so syntax colors inside the line do
	// not cancel it; finish with DIM_OFF so nothing leaks past the line.
	return DIM + text.replaceAll("\x1b[0m", `\x1b[0m${DIM}`) + DIM_OFF;
}

function parseFocus(spec: string, lineCount: number): Set<number> | undefined {
	const set = new Set<number>();
	let valid = false;
	for (const part of spec.split(",")) {
		const seg = part.trim();
		if (!seg) continue;
		const range = /^([0-9]+)\s*-\s*([0-9]+)$/.exec(seg);
		if (range) {
			const a = Number(range[1]);
			const b = Number(range[2]);
			if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) continue;
			valid = true;
			// Never enumerate outside the rendered block, even for reversed ranges.
			const end = Math.min(lineCount, Math.max(a, b));
			for (let n = Math.max(1, Math.min(a, b)); n <= end; n++) set.add(n);
		} else if (/^[0-9]+$/.test(seg)) {
			const n = Number(seg);
			if (!Number.isSafeInteger(n)) continue;
			valid = true;
			if (n >= 1 && n <= lineCount) set.add(n);
		}
	}
	// A valid but out-of-bounds selection still dims every line, as before.
	return valid ? set : undefined;
}

function parseFenceInfo(info: string): FenceInfo {
	const parsed: FenceInfo = { lang: "", lineNumbers: false, lineNumbersStart: 1 };
	let rest = (info ?? "").trim();
	if (!rest) return parsed;

	// title="..." | title='...' | title=word (extract first so flag searches
	// below cannot match inside the title text)
	const titleMatch = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rest);
	if (titleMatch) {
		const value = (titleMatch[1] ?? titleMatch[2] ?? titleMatch[3] ?? "").trim();
		if (value) parsed.title = value;
		rest = (rest.slice(0, titleMatch.index) + " " + rest.slice(titleMatch.index + titleMatch[0].length)).trim();
	}

	// {2,4-6} line focus
	const braces = /\{\s*([0-9][0-9\s,-]*)\}/.exec(rest);
	if (braces) {
		parsed.focus = braces[1];
		rest = (rest.slice(0, braces.index) + " " + rest.slice(braces.index + braces[0].length)).trim();
	}

	// :line-numbers with optional start offset. Matches when the flag attaches
	// directly to the language ("bash:line-numbers") or stands alone.
	const lineNums = /:(?:line-numbers)(?:=([0-9]+))?(?![\w-])/.exec(rest);
	if (lineNums) {
		parsed.lineNumbers = true;
		if (lineNums[1]) parsed.lineNumbersStart = Math.max(1, Number(lineNums[1]));
		rest = (rest.slice(0, lineNums.index) + " " + rest.slice(lineNums.index + lineNums[0].length)).trim();
	}

	// Language: first word of what remains (stops at space, ":" or "{").
	const lang = /^[^ \t:{}]+/.exec(rest);
	if (lang) parsed.lang = lang[0];
	return parsed;
}

/** Top rule: language prefix, optional embedded title, dashes to full width. */
function composeTopRule(width: number, parsed: FenceInfo): string {
	const w = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));

	const lang = /[\r\n]/.test(parsed.lang) ? "" : parsed.lang;
	if (parsed.title && !/[\r\n]/.test(parsed.title)) {
		const label = SHOW_LANGUAGE && lang ? `${lang}${BORDER_CHAR.repeat(2)} ` : `${BORDER_CHAR.repeat(2)} `;
		const candidate = `${label}${parsed.title} `;
		const candidateWidth = visibleWidth(candidate);
		if (candidateWidth + 1 <= w) {
			return candidate + BORDER_CHAR.repeat(w - candidateWidth);
		}
		// Title too long for the rule; fall through to language-only rule.
	}

	const langWidth = visibleWidth(lang);
	if (SHOW_LANGUAGE && lang && langWidth < w) {
		return lang + BORDER_CHAR.repeat(w - langWidth);
	}
	return BORDER_CHAR.repeat(w);
}

interface HighlightCodeFn {
	(code: string, lang: string): string[];
}

interface ThemeLike {
	codeBlockBorder?: (text: string) => string;
	highlightCode?: HighlightCodeFn;
}

interface MarkdownLike {
	theme?: ThemeLike;
}

type RenderTokenFn = (
	this: MarkdownLike,
	token: unknown,
	width: number,
	nextTokenType?: string,
	styleContext?: unknown,
) => string[];

/** Apply :line-numbers and {2,4-6} to highlighted code lines. */
function decorateLines(lines: string[], parsed: FenceInfo): string[] {
	let out = lines;

	if (parsed.lineNumbers && out.length > 0) {
		// Drop one trailing empty line so a numbered blank line does not sit
		// against the bottom rule.
		const last = out[out.length - 1];
		if (out.length > 1 && stripAnsi(last).trim() === "") {
			out = out.slice(0, -1);
		}
		const start = parsed.lineNumbersStart;
		const gutterWidth = String(start + out.length - 1).length;
		out = out.map((line, i) => {
			const n = String(start + i).padStart(gutterWidth, " ");
			return dimText(`${n}${GUTTER_SEP}`) + line;
		});
	}

	const focus = parsed.focus ? parseFocus(parsed.focus, out.length) : undefined;
	if (focus) {
		out = out.map((line, i) => (focus.has(i + 1) ? line : dimText(line)));
	}

	return out;
}

export default function (pi: ExtensionAPI) {
	const proto = Markdown.prototype as unknown as {
		renderToken?: RenderTokenFn;
		__codeblockBordersPatched?: boolean | RenderTokenFn;
	};

	// Legacy boolean markers cannot be safely unwrapped: restart once to migrate.
	// New markers identify the owner so stale shutdowns cannot remove a reload.
	if (proto.__codeblockBordersPatched) return;

	const originalRenderToken = proto.renderToken;
	if (typeof originalRenderToken !== "function") {
		// pi-tui internals changed; stay inert instead of breaking rendering.
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				"codeblock-borders: Markdown.renderToken not found, extension inactive",
				"warning",
			);
		});
		return;
	}

	let active = true;
	const renderToken: RenderTokenFn = function (token, width, nextTokenType, styleContext) {
		// A later wrapper may retain us in its chain after shutdown.
		if (!active) return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		const theme = this.theme;
		const originalBorder = theme?.codeBlockBorder;
		const originalHighlight = theme?.highlightCode;
		if (!theme || typeof originalBorder !== "function") {
			return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		}

		// codeBlockBorder is called once for the opening fence ("```info") and
		// once for the closing fence ("```"). Nested renders (fenced code inside a
		// list/blockquote) swap this wrapper again while the outer swap is still
		// active, so the inner wrapper's composed rule can arrive here as "text"
		// through the outer wrapper's originalBorder — it does not start with
		// "```", so pass it through unchanged instead of re-composing it at the
		// outer (larger) width, which overflowed the nested content width.
		theme.codeBlockBorder = (text: string) => {
			if (!text.startsWith("```")) {
				return originalBorder(text);
			}
			return originalBorder(composeTopRule(width, parseFenceInfo(text.slice(3))));
		};

		if (typeof originalHighlight === "function") {
			// The renderer passes the full info string as the language. Feed
			// highlight.js only the leading language word so decorated fences
			// ("bash:line-numbers {2}" etc.) keep syntax highlighting, then
			// apply the gutter/focus decorations.
			theme.highlightCode = (code: string, infoLang: string) => {
				const parsed = parseFenceInfo(infoLang ?? "");
				const lines = originalHighlight(code, parsed.lang || infoLang || "");
				return decorateLines(lines, parsed);
			};
		}

		try {
			return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		} finally {
			theme.codeBlockBorder = originalBorder;
			if (theme && typeof originalHighlight === "function") {
				theme.highlightCode = originalHighlight;
			}
		}
	};

	proto.renderToken = renderToken;
	proto.__codeblockBordersPatched = renderToken;
	pi.on("session_shutdown", () => {
		if (!active) return;
		active = false;
		// Do not overwrite another extension's wrapper. Our retained wrapper is
		// now pass-through, and a replacement can safely wrap the current chain.
		if (proto.renderToken === renderToken) proto.renderToken = originalRenderToken;
		if (proto.__codeblockBordersPatched === renderToken) delete proto.__codeblockBordersPatched;
	});
}
