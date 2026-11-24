import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Editor } from "@earendil-works/pi-tui";
import type {
	getAnswer,
	getCurrentQuestion,
	getRenderableOptions,
} from "../state/selectors.ts";
import type { AskDisplayOption, AskState } from "../types.ts";

import type { PreviewPagination } from "./preview-pagination.ts";

export type Theme = ExtensionContext["ui"]["theme"];

export interface QuestionRenderContext {
	editor: Editor;
	height?: number;
	lines: string[];
	options: ReturnType<typeof getRenderableOptions>;
	preview?: PreviewPagination;
	question: NonNullable<ReturnType<typeof getCurrentQuestion>>;
	state: AskState;
	theme: Theme;
	width: number;
}

export interface OptionDetailRenderContext {
	answer: ReturnType<typeof getAnswer>;
	editor: Editor;
	lines: string[];
	option: AskDisplayOption | undefined;
	questionId: string;
	selected?: boolean;
	state: AskState;
	theme: Theme;
	width: number;
}
