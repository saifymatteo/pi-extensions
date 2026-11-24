import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
	Editor,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import type { AskConfig } from "../src/config/schema.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import { runAskFlow } from "../src/ui/controller.ts";

const preview = Array.from(
	{ length: 120 },
	(_, index) => `PROPOSAL ROW ${String(index + 1).padStart(3, "0")}`
).join("\n");

interface FlowComponent {
	capturesViewportInput: boolean;
	dispose(): void;
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	render(width: number): string[];
}

async function openFlow(
	t: TestContext,
	config = DEFAULT_ASK_CONFIG,
	content = preview
) {
	getAskConfigStore().setConfig({
		...config,
		behaviour: { ...config.behaviour, confirmDismissWhenDirty: false },
		notifications: { ...config.notifications, enabled: false },
	});
	let component: FlowComponent | undefined;
	let markReady: () => void;
	const ready = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	const abort = new AbortController();
	const tui = {
		terminal: { rows: 40, columns: 120 },
		requestRender() {
			// Tests explicitly render after each input, as the host does.
		},
	};
	const running = runAskFlow(
		{
			cwd: process.cwd(),
			mode: "tui",
			abort() {
				// No agent operation exists in this fixture.
			},
			ui: {
				custom(factory: (...args: unknown[]) => unknown) {
					return new Promise((resolve) => {
						component = factory(
							tui,
							{
								fg: (_color: string, text: string) => text,
								bg: (_color: string, text: string) => text,
								bold: (text: string) => text,
							},
							{ matches: () => false, getKeys: () => [] },
							resolve
						) as FlowComponent;
						markReady();
					});
				},
			},
		} as never,
		{
			title: "Review proposal",
			questions: [
				{
					id: "proposal",
					prompt: "Which draft should we use?",
					type: "preview",
					options: [
						{ value: "first", label: "First draft", preview: content },
						{ value: "second", label: "Second draft", preview: content },
					],
				},
			],
		},
		{ signal: abort.signal }
	);
	t.after(async () => {
		abort.abort();
		await running;
		component?.dispose();
		getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
	});
	await Promise.race([
		ready,
		running.then(() => {
			throw new Error("Ask finished before opening its component");
		}),
	]);
	assert(component);
	return { component, tui, running };
}

function range(lines: string[]): string | undefined {
	return lines.find((line) => line.includes("Rows "));
}

function wheel(x: number, y: number, wheelDelta = 3): TuiMouseEvent {
	return {
		type: "wheel",
		button: "none",
		x,
		y,
		screenX: x + 100,
		screenY: y + 100,
		width: 120,
		height: 34,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta,
	};
}

function previewPoint(lines: string[]) {
	const y = lines.findIndex((line) => line.includes("┌"));
	assert(y >= 0);
	return { x: lines[y].indexOf("┌") + 1, y: y + 1 };
}

test("production preview pages without answering and releases keys on Review", async (t) => {
	const { component, running } = await openFlow(t);
	const first = component.render(120);
	assert.equal(component.capturesViewportInput, true);
	assert(first.some((line) => line.includes("PROPOSAL ROW 001")));
	component.handleInput("\x1b[6~");
	const next = component.render(120);
	assert.notEqual(range(next), range(first));
	assert(next.some((line) => line.includes("First draft")));
	component.handleInput("\x1b[5~");
	assert.deepEqual(component.render(120), first);
	component.handleInput("\x1b[F");
	assert(
		component.render(120).some((line) => line.includes("PROPOSAL ROW 120"))
	);
	component.handleInput("\x1b[H");
	assert.deepEqual(component.render(120), first);
	component.handleInput("\r");
	assert.equal(component.capturesViewportInput, false);
	component.handleInput("\r");
	const result = await running;
	assert.deepEqual(result.answers.proposal.values, ["first"]);
});

test("changing options or question type resets the preview page", async (t) => {
	const { component } = await openFlow(t);
	const firstRange = range(component.render(120));
	component.handleInput("\x1b[F");
	component.render(120);
	component.handleInput("\x1b[B");
	assert.equal(range(component.render(120)), firstRange);
	component.handleInput("t");
	assert.equal(component.capturesViewportInput, false);
	assert.equal(range(component.render(120)), undefined);
	component.handleInput("t");
	assert.equal(component.capturesViewportInput, true);
	// The type-change notice consumes a footer row, but the offset resets.
	assert(range(component.render(120))?.includes("Rows 1–"));
});

test("leaving the preview tab resets its page and resizing remeasures it", async (t) => {
	const { component, tui } = await openFlow(t);
	component.render(120);
	component.handleInput("\x1b[F");
	component.render(120);
	component.handleInput("\t");
	component.render(120);
	assert.equal(component.capturesViewportInput, false);
	component.handleInput("\x1b[Z");
	assert(range(component.render(120))?.includes("Rows 1–"));
	tui.terminal.rows = 32;
	assert(component.render(60).length <= 26);
	component.handleInput("\x1b[F");
	assert(
		component.render(60).some((line) => line.includes("PROPOSAL ROW 120"))
	);
	tui.terminal.rows = 48;
	assert(
		component.render(120).some((line) => line.includes("PROPOSAL ROW 120"))
	);
});

test("configured Ask bindings take precedence over preview paging", async (t) => {
	const config: AskConfig = {
		...DEFAULT_ASK_CONFIG,
		keymaps: {
			...DEFAULT_ASK_CONFIG.keymaps,
			main: {
				...DEFAULT_ASK_CONFIG.keymaps.main,
				nextTab: ["pageDown"],
			},
		},
	};
	const { component } = await openFlow(t, config);
	component.render(120);
	component.handleInput("\x1b[6~");
	assert.equal(component.capturesViewportInput, false);
	assert.equal(range(component.render(120)), undefined);
});

test("note editors retain native paging instead of scrolling the proposal", async (t) => {
	const received: string[] = [];
	const original = Editor.prototype.handleInput;
	Editor.prototype.handleInput = function handleInput(data: string) {
		received.push(data);
		original.call(this, data);
	};
	t.after(() => {
		Editor.prototype.handleInput = original;
	});
	const { component } = await openFlow(t);
	component.render(120);
	component.handleInput("n");
	const before = range(component.render(120));
	component.handleInput("\x1b[6~");
	assert(received.includes("\x1b[6~"));
	assert.equal(range(component.render(120)), before);
	assert.equal(component.capturesViewportInput, true);
});

for (const width of [120, 60]) {
	test(`wheel scrolling at width ${width} is local to the preview and preserves the answer`, async (t) => {
		const { component, running } = await openFlow(t);
		const first = component.render(width);
		const point = previewPoint(first);
		const event = wheel(point.x, point.y);
		assert.deepEqual(component.handleMouse(event), {
			handled: true,
			render: true,
		});
		assert(range(component.render(width))?.includes("Rows 4–"));
		assert.deepEqual(component.handleMouse({ ...event, wheelDelta: -3 }), {
			handled: true,
			render: true,
		});
		assert.deepEqual(component.render(width), first);
		component.handleInput("\r");
		assert.equal(component.handleMouse(event), undefined);
		component.handleInput("\r");
		assert.deepEqual((await running).answers.proposal.values, ["first"]);
	});
}

test("wheel events outside the box or without a valid delta remain unhandled", async (t) => {
	const { component } = await openFlow(t);
	const first = component.render(120);
	const point = previewPoint(first);
	const bottom = first.findIndex((line) => line.includes("Rows "));
	const events: TuiMouseEvent[] = [
		wheel(point.x - 2, point.y),
		wheel(120, point.y),
		wheel(point.x, point.y - 2),
		wheel(point.x, bottom + 1),
		{ ...wheel(point.x, point.y), type: "click" },
		wheel(point.x, point.y, 0),
		wheel(point.x, point.y, Number.NaN),
		wheel(point.x, point.y, Number.POSITIVE_INFINITY),
		{ ...wheel(point.x, point.y), wheelDelta: undefined },
	];
	for (const event of events) {
		assert.equal(component.handleMouse(event), undefined);
	}
	assert.deepEqual(component.render(120), first);
});

test("wheel scrolling clamps at both ends without leaking into transcript scrolling", async (t) => {
	const { component } = await openFlow(t);
	const point = previewPoint(component.render(120));
	const top = wheel(point.x, point.y, -1000);
	assert.deepEqual(component.handleMouse(top), {
		handled: true,
		render: false,
	});
	assert.deepEqual(component.handleMouse({ ...top, wheelDelta: 1000 }), {
		handled: true,
		render: true,
	});
	assert(
		component.render(120).some((line) => line.includes("PROPOSAL ROW 120"))
	);
	assert.deepEqual(component.handleMouse({ ...top, wheelDelta: 1000 }), {
		handled: true,
		render: false,
	});
	component.handleMouse(top);
	assert(range(component.render(120))?.includes("Rows 1–"));
});

test("a short preview consumes only its own wheel events without moving", async (t) => {
	const { component } = await openFlow(t, DEFAULT_ASK_CONFIG, "Short proposal");
	const first = component.render(120);
	const point = previewPoint(first);
	assert.deepEqual(component.handleMouse(wheel(point.x, point.y)), {
		handled: true,
		render: false,
	});
	assert.equal(component.handleMouse(wheel(0, 0)), undefined);
	assert.deepEqual(component.render(120), first);
});

test("mouse bounds are remeasured on resize and cleared when the preview disappears", async (t) => {
	const { component } = await openFlow(t);
	component.render(120);
	assert.equal(component.handleMouse(wheel(1, 2)), undefined);
	const stacked = component.render(60);
	const point = previewPoint(stacked);
	assert.equal(component.handleMouse(wheel(point.x, point.y))?.handled, true);
	component.handleInput("\x1b[B");
	// Selection changes invalidate the old hitbox before the next render.
	assert.equal(component.handleMouse(wheel(point.x, point.y)), undefined);
	component.render(60);
	component.handleInput("t");
	assert.equal(component.handleMouse(wheel(point.x, point.y)), undefined);
	component.render(60);
	assert.equal(component.handleMouse(wheel(point.x, point.y)), undefined);
});

test("wheeling a preview while editing a note does not take keyboard focus", async (t) => {
	const { component } = await openFlow(t);
	component.handleInput("n");
	const point = previewPoint(component.render(120));
	assert.deepEqual(component.handleMouse(wheel(point.x, point.y)), {
		handled: true,
		render: true,
	});
	assert(range(component.render(120))?.includes("Rows 4–"));
	component.handleInput("note stays in the editor");
	assert(component.render(120).some((line) => line.includes("note stays")));
});
