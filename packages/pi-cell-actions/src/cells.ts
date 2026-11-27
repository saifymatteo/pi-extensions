/**
 * Pure helpers: find code blocks and tables in message Markdown, locate them in
 * the rendered rows, and convert tables to TSV/CSV. No Pi imports, so tests run
 * without a host and the logic is shared by stock Pi and Pi-Bolt renderers.
 */

export type SourceBlock =
	| { kind: "text"; markdown: string }
	| { kind: "code"; lang: string; code: string }
	| { kind: "table"; markdown: string; rows: string[][] };

/** A source block and the rendered rows it covers (inclusive, local to the component). */
export type LocatedBlock = SourceBlock & { top: number; bottom: number };

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split a GFM table row into trimmed cells; `\|` stays a literal pipe. */
export function tableCells(line: string): string[] {
	let row = line.trim();
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
	return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/**
 * A message split into blocks, in source order: fenced code (nested too), GFM
 * tables, and text (paragraphs, lists, quotes) split at blank lines; headings
 * stand alone.
 */
export function parseBlocks(markdown: string): SourceBlock[] {
	const lines = markdown.split("\n");
	const blocks: SourceBlock[] = [];
	let text: string[] = [];
	const flush = () => {
		if (text.length) blocks.push({ kind: "text", markdown: text.join("\n") });
		text = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const open = FENCE.exec(lines[i]);
		if (open) {
			flush();
			const [, indent, fence, info] = open;
			const body: string[] = [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j]);
				if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
				// Code inside a list item carries the item's indent; drop up to that much.
				body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j].trimStart());
			}
			blocks.push({ kind: "code", lang: info.trim().split(/[\s:{]/)[0] ?? "", code: body.join("\n") });
			i = j;
			continue;
		}
		if (lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && DELIMITER_ROW.test(lines[i + 1])) {
			flush();
			const raw = [lines[i], lines[i + 1]];
			let j = i + 2;
			for (; j < lines.length && lines[j].includes("|") && lines[j].trim() !== ""; j++) raw.push(lines[j]);
			blocks.push({
				kind: "table",
				markdown: raw.map((line) => line.trim()).join("\n"),
				rows: [raw[0], ...raw.slice(2)].map(tableCells),
			});
			i = j - 1;
			continue;
		}
		if (lines[i].trim() === "") flush();
		else if (/^\s{0,3}#{1,6}\s/.test(lines[i])) {
			flush();
			text.push(lines[i]);
			flush();
		} else text.push(lines[i]);
	}
	flush();
	return blocks;
}

/** Letters and digits only: rendered rows drop Markdown syntax and add bullets. */
const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");

/** The first letters a text block shows once rendered (markers, links and emphasis removed). */
function textHead(markdown: string): string {
	for (const line of markdown.split("\n")) {
		const shown = line
			.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
		// Lines without letters (a lone `{`) are skipped; locateBlocks takes the rows back.
		if (letters(shown)) return letters(shown).slice(0, 16);
	}
	return "";
}

function isFenceBorder(text: string, lang: string): boolean {
	const t = text.trim();
	// Stock fences (```lang), rules from pi-codeblock-borders, or Pi-Bolt's shaded language label.
	return t.startsWith("```") || t.startsWith("~~~") || /─{3,}/.test(t) || (lang !== "" && t === lang);
}

/**
 * Map source blocks to the rows a renderer drew them on, by content: renderers
 * differ (stock fences, shaded blocks, pi-codeblock-borders rules and gutters),
 * but every one draws each code line's text and tables with box corners.
 * A block that cannot be found is dropped; later blocks keep searching.
 */
export function locateBlocks(rows: string[], blocks: SourceBlock[]): LocatedBlock[] {
	const located: LocatedBlock[] = [];
	let cursor = 0;
	for (const block of blocks) {
		if (block.kind === "text") {
			// Its bottom is set by the next located block; blank rows below stay with it.
			const head = textHead(block.markdown);
			if (!head) continue;
			let top = rows.findIndex((row, i) => i >= cursor && letters(row).includes(head));
			if (top === -1) continue;
			while (top > cursor && rows[top - 1].trim() && !letters(rows[top - 1])) top--;
			located.push({ ...block, top, bottom: rows.length - 1 });
			cursor = top + 1;
			continue;
		}
		if (block.kind === "code") {
			const codeLines = block.code.split("\n");
			const firstIndex = codeLines.findIndex((line) => line.trim() !== "");
			if (firstIndex === -1) continue;
			const lastIndex = codeLines.findLastIndex((line) => line.trim() !== "");
			const head = codeLines[firstIndex].trim().slice(0, 40);
			const tail = codeLines[lastIndex].trim().slice(-30);
			const start = rows.findIndex((row, i) => i >= cursor && row.includes(head));
			if (start === -1) continue;
			const end = rows.findIndex((row, i) => i >= start + (lastIndex - firstIndex) && row.includes(tail));
			if (end === -1) continue;
			const top = start > 0 && isFenceBorder(rows[start - 1], block.lang) ? start - 1 : start;
			const bottom = end + 1 < rows.length && isFenceBorder(rows[end + 1], block.lang) ? end + 1 : end;
			located.push({ ...block, top, bottom });
			cursor = bottom + 1;
		} else {
			const top = rows.findIndex((row, i) => i >= cursor && row.trimStart().startsWith("┌"));
			if (top === -1) continue;
			const bottom = rows.findIndex((row, i) => i > top && row.trimStart().startsWith("└"));
			if (bottom === -1) continue;
			located.push({ ...block, top, bottom });
			cursor = bottom + 1;
		}
	}
	// A text block ends where the next one starts.
	located.forEach((block, i) => {
		if (block.kind === "text" && located[i + 1]) block.bottom = Math.min(block.bottom, located[i + 1].top - 1);
	});
	return located;
}

export function toTsv(rows: string[][]): string {
	return rows.map((row) => row.map((cell) => cell.replace(/[\t\n]/g, " ")).join("\t")).join("\n");
}

export function toCsv(rows: string[][]): string {
	const quote = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
	return rows.map((row) => row.map(quote).join(",")).join("\n");
}

/** Languages whose code blocks get a "run" action; the value is the shell to run them with. */
export const RUNNABLE: Record<string, string> = { bash: "bash", sh: "sh", shell: "bash", zsh: "zsh" };
