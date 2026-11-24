import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	type EditorTheme,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const EDITOR_PADDING_X = 1;
const EDITOR_FRAME_MIN_WIDTH = 6;
const EDITOR_STATUS_MIN_WIDTH = 12;

const RULE_PATTERN = /^─+(?: [↑↓] \d+ more ─*)?\.{0,3}$/;

function isEditorRuleText(plain: string): boolean {
	return plain.length > 0 && RULE_PATTERN.test(plain);
}

function fitsStatusLine(status: string, width: number): boolean {
	return stripTerminalSequences(status).trim().length > 0 && visibleWidth(status) <= width;
}

function framedStatusRule(
	innerRule: string,
	width: number,
	borderColor: (text: string) => string,
	renderStatusLine?: (width: number) => string,
): string {
	if (!renderStatusLine) return innerRule;

	const scrollIndicator = stripTerminalSequences(innerRule).match(/↑ \d+ more/)?.[0];
	const scrollSuffix = scrollIndicator ? ` ${scrollIndicator} ─` : "";
	// Keep the existing status budget: "── " before it and " ──" after it.
	const statusWidth = width - 6 - visibleWidth(scrollSuffix);
	if (statusWidth < EDITOR_STATUS_MIN_WIDTH) return innerRule;

	const status = renderStatusLine(statusWidth);
	if (!fitsStatusLine(status, statusWidth)) return innerRule;

	const remainingRule = "─".repeat(statusWidth - visibleWidth(status) + 2);
	return `${borderColor("── ")}${status}${borderColor(` ${remainingRule}${scrollSuffix}`)}`;
}

/** Add Atelier's status header without changing native editor rows or autocomplete placement. */
function frameEditorLines(
	inner: readonly string[],
	width: number,
	borderColor: (text: string) => string,
	renderStatusLine?: (width: number) => string,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const lines = inner.map((line) => truncateToWidth(line, safeWidth, ""));
	const topRule = lines[0];
	if (
		safeWidth >= EDITOR_FRAME_MIN_WIDTH &&
		topRule !== undefined &&
		isEditorRuleText(stripTerminalSequences(topRule))
	) {
		lines[0] = framedStatusRule(topRule, safeWidth, borderColor, renderStatusLine);
	}
	return lines;
}

/** Full-width, copy-friendly composer. Preserves Pi's editing behavior and border colors. */
export class AtelierEditor extends CustomEditor {
	/** Optional ANSI status content for the top rule; receives its available column width. */
	renderStatusLine: ((width: number) => string) | undefined;
	/** Whether the most recent render included the status line in its top rule. */
	statusLineVisible = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: EDITOR_PADDING_X });
	}

	override setPaddingX(_padding: number): void {
		// Pi reapplies editorPaddingX when installing or updating the editor.
		super.setPaddingX(EDITOR_PADDING_X);
	}

	override render(width: number): string[] {
		this.statusLineVisible = false;
		const safeWidth = Math.max(0, Math.trunc(width));
		const renderStatusLine = this.renderStatusLine;
		return frameEditorLines(
			super.render(safeWidth),
			safeWidth,
			this.borderColor,
			renderStatusLine
				? (availableWidth) => {
						const status = renderStatusLine(availableWidth);
						this.statusLineVisible = fitsStatusLine(status, availableWidth);
						return status;
					}
				: undefined,
		);
	}
}
