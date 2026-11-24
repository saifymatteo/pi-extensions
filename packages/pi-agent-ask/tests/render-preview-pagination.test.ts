import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { createInitialState } from "../src/state/create.ts";
import {
	enterOptionNoteMode,
	enterQuestionNoteMode,
} from "../src/state/transitions.ts";
import type {
	PreviewBounds,
	PreviewPage,
} from "../src/ui/preview-pagination.ts";
import { renderAskScreen } from "../src/ui/render.ts";
import { renderPreviewPaneContent } from "../src/ui/render-helpers.ts";

function plainTheme(onColor?: (color: string, text: string) => void) {
	return {
		fg(color: string, text: string) {
			onColor?.(color, text);
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	} as never;
}

function mockEditor() {
	return {
		getText() {
			return "note text";
		},
		render() {
			return ["┌────┐", "note first", "note second", "└────┘"];
		},
	} as never;
}

function previewState(
	preview = Array.from({ length: 126 }, (_, i) => `Proposal row ${i + 1}`).join(
		"\n"
	)
) {
	return createInitialState({
		title: "Review proposal",
		questions: [
			{
				id: "q1",
				prompt: "Pick a proposal",
				type: "preview",
				options: [
					{ value: "a", label: "Proposal A", preview },
					{ value: "b", label: "Proposal B", preview: "Alternative" },
				],
			},
		],
	});
}

test("short previews remain byte-for-byte unchanged and report full layout", () => {
	const option = {
		label: "Proposal",
		description: "Description",
		preview: "Short\npreview",
	};
	const original = renderPreviewPaneContent(option, plainTheme(), 50);
	const pages: PreviewPage[] = [];
	const actual = renderPreviewPaneContent(option, plainTheme(), 50, {
		maxHeight: original.length,
		pagination: { offset: 500, onLayout: (page) => pages.push(page) },
	});
	assert.deepEqual(actual, original);
	assert.deepEqual(pages, [
		{ offset: 0, pageSize: original.length - 2, total: original.length - 2 },
	]);
	assert.deepEqual(
		renderPreviewPaneContent(option, plainTheme(), 50, {
			pagination: { offset: 500, onLayout: (page) => pages.push(page) },
		}),
		original
	);
	assert.equal(pages.length, 2);
});

test("viewport slices wrapped interior rows, retains borders, and reaches the final row", () => {
	const preview = `${"word ".repeat(2000)}FINAL_ROW`;
	const option = { label: "Proposal", preview };
	const full = renderPreviewPaneContent(option, plainTheme(), 40);
	const pages: PreviewPage[] = [];
	const colors: string[] = [];
	const theme = plainTheme((color, text) => {
		if (text.startsWith("Rows ")) {
			colors.push(color);
		}
	});
	const first = renderPreviewPaneContent(option, theme, 40, {
		maxHeight: 9,
		pagination: { offset: -100, onLayout: (page) => pages.push(page) },
	});
	assert.equal(first.length, 9);
	assert.deepEqual(first.slice(1, -2), full.slice(1, 7));
	assert.equal(first[0], full[0]);
	assert.equal(first.at(-2), full.at(-1));
	assert.equal(pages[0].offset, 0);
	assert.equal(pages[0].pageSize, 6);
	assert.equal(pages[0].total, full.length - 2);
	const last = renderPreviewPaneContent(option, theme, 40, {
		maxHeight: 9,
		pagination: {
			offset: Number.MAX_SAFE_INTEGER,
			onLayout: (page) => pages.push(page),
		},
	});
	assert(last.some((line) => line.includes("FINAL_ROW")));
	assert.equal(pages[1].offset + pages[1].pageSize, pages[1].total);
	assert.deepEqual(last.slice(1, -2), full.slice(-7, -1));
	assert(last.every((line) => visibleWidth(line) <= 40));
	assert.deepEqual(colors, ["dim", "dim"]);
	assert.equal(option.preview, preview);
});

for (const width of [120, 80, 40]) {
	test(`real screen at width ${width} budgets footer, options and wrapped notes`, () => {
		let state = previewState();
		state.questions[0].prompt =
			"Choose the proposal that best fits the implementation requirements. ".repeat(
				2
			);
		state.questions[0].options[1].description =
			"An alternative with a wrapped description for narrow terminals";
		state = enterQuestionNoteMode(state, "q1");
		const pages: PreviewPage[] = [];
		const render = (offset: number) =>
			renderAskScreen({
				config: DEFAULT_ASK_CONFIG,
				state,
				theme: plainTheme(),
				width,
				height: 44,
				editor: mockEditor(),
				footerNotice:
					"A footer notice that should stay visible even when it wraps across terminal rows.",
				preview: { offset, onLayout: (page) => pages.push(page) },
			});
		const first = render(0);
		assert(first.length <= 44, `screen uses ${first.length} rows`);
		assert(first.some((line) => line.includes("Proposal B")));
		assert(first.some((line) => line.includes("Type your own")));
		assert(first.some((line) => line.includes("note second")));
		assert(first.some((line) => line.includes("A footer notice")));
		assert(first.some((line) => line.includes("Rows 1–")));
		assert(first.every((line) => visibleWidth(line) <= width));
		assert.equal(first.at(-1), "─".repeat(width));
		const last = render(Number.MAX_SAFE_INTEGER);
		assert(last.some((line) => line.includes("Proposal row 126")));
		assert.equal(pages[1].offset + pages[1].pageSize, pages[1].total);
		assert(last.length <= 44);
		assert.equal(
			state.questions[0].options[0].preview?.split("\n").length,
			126
		);
	});
}

test("standard 24-row terminals keep options and footer outside the preview", () => {
	for (const width of [120, 80, 40]) {
		const args = {
			config: DEFAULT_ASK_CONFIG,
			state: previewState(),
			theme: plainTheme(),
			width,
			editor: mockEditor(),
		};
		const unbounded = renderAskScreen(args);
		const bounded = renderAskScreen({ ...args, height: 24 });
		assert(
			bounded.length <= 24,
			`${width} columns uses ${bounded.length} rows`
		);
		assert(bounded.some((line) => line.includes("Type your own")));
		const footerStart = unbounded.lastIndexOf("");
		assert.deepEqual(
			bounded.slice(-(unbounded.length - footerStart)),
			unbounded.slice(footerStart)
		);
	}
});

test("selected option detail rows are reserved before sizing the preview", () => {
	const state = enterOptionNoteMode(previewState(), "q1", "a");
	const lines = renderAskScreen({
		config: DEFAULT_ASK_CONFIG,
		state,
		theme: plainTheme(),
		width: 80,
		height: 30,
		editor: mockEditor(),
	});
	assert.equal(lines.length, 30);
	const bottom = lines.findIndex((line) => line.startsWith("└"));
	assert(bottom > 0);
	assert(lines.slice(bottom + 1).some((line) => line.includes("note second")));
	assert(lines.some((line) => line.includes("Rows 1–")));
});

test("short real screens preserve existing rendering with an optional height", () => {
	for (const width of [120, 80, 40]) {
		const args = {
			config: DEFAULT_ASK_CONFIG,
			state: previewState("Short proposal"),
			theme: plainTheme(),
			width,
			editor: mockEditor(),
		};
		assert.deepEqual(
			renderAskScreen({ ...args, height: 50 }),
			renderAskScreen(args)
		);
	}
});

test("wrapped saved question and option notes leave the footer visible", () => {
	const state = previewState();
	state.answers.q1 = {
		selected: [],
		note: "Question note that wraps over several terminal rows. ".repeat(3),
		optionNotes: {
			a: "Selected option note wrapping over terminal rows. ".repeat(3),
		},
	};
	const lines = renderAskScreen({
		config: DEFAULT_ASK_CONFIG,
		state,
		theme: plainTheme(),
		width: 40,
		height: 48,
		editor: mockEditor(),
	});
	assert.equal(lines.length, 48);
	assert(lines.some((line) => line.includes("Question note")));
	assert(lines.some((line) => line.includes("Selected option note")));
	assert(lines.some((line) => line.includes("Rows 1–")));
	assert.equal(lines.at(-1), "─".repeat(40));
});

test("every wrapped interior row can be visited without changing the source", () => {
	const option = {
		label: "Proposal",
		preview: `${"long wrapped proposal ".repeat(400)}LAST`,
	};
	const full = renderPreviewPaneContent(option, plainTheme(), 30);
	const visited: string[] = [];
	let offset = 0;
	let page: PreviewPage = { offset: 0, pageSize: 1, total: 1 };
	while (offset < full.length - 2) {
		const lines = renderPreviewPaneContent(option, plainTheme(), 30, {
			maxHeight: 10,
			pagination: {
				offset,
				onLayout: (layout) => {
					page = layout;
				},
			},
		});
		const alreadyVisited = offset - page.offset;
		visited.push(...lines.slice(1 + alreadyVisited, -2));
		offset = page.offset + page.pageSize;
	}
	assert.deepEqual(visited, full.slice(1, -1));
});

for (const width of [120, 80, 40]) {
	for (const preview of [
		"Short proposal",
		"A long proposal row\n".repeat(100),
	]) {
		test(`mouse bounds at width ${width} match the ${preview.startsWith("Short") ? "short" : "paged"} preview box`, () => {
			const state = previewState(preview);
			state.questions[0].prompt = "Wrapped question prompt. ".repeat(5);
			state.answers.q1 = {
				selected: [],
				note: "A wrapped saved note. ".repeat(3),
			};
			const bounds: PreviewBounds[] = [];
			const lines = renderAskScreen({
				config: DEFAULT_ASK_CONFIG,
				state,
				theme: plainTheme(),
				width,
				height: 50,
				editor: mockEditor(),
				preview: { offset: 0, onLayout: (_page, rect) => bounds.push(rect) },
			});
			assert.equal(bounds.length, 1);
			const rect = bounds[0];
			const top = lines.findIndex((line) => line.includes("┌"));
			const bottom = lines.findIndex((line) => line.includes("└"));
			assert.equal(rect.x, lines[top].indexOf("┌"));
			assert.equal(rect.y, top);
			assert.equal(rect.width, width - rect.x);
			const last = lines[bottom + 1]?.includes("Rows ") ? bottom + 1 : bottom;
			assert.equal(rect.height, last - top + 1);
			assert.equal(rect.x > 0, width === 120);
		});
	}
}

test("tiny viewport budgets still expose at least one content row", () => {
	const pages: PreviewPage[] = [];
	const lines = renderPreviewPaneContent(
		{ label: "A", preview: "one\ntwo\nthree" },
		plainTheme(),
		20,
		{
			maxHeight: 1,
			pagination: { offset: 0, onLayout: (page) => pages.push(page) },
		}
	);
	assert.equal(lines.length, 4);
	assert.equal(pages[0].pageSize, 1);
});
