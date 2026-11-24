import assert from "node:assert/strict";
import test from "node:test";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AskResult } from "../src/types.ts";
import { showPersistentAsk } from "../src/ui/persistent-ask.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const answer: AskResult = {
	cancelled: false,
	mode: "submit",
	questions: [],
	answers: {},
};

function harness() {
	const editor = { getText: () => "", setText: () => undefined };
	const tui = { children: [editor] as unknown[] };
	const widgets = new Map<string, { render: () => string[] }>();
	let mounts = 0;
	const customOptions: unknown[] = [];
	const ctx = {
		ui: {
			setWidget(key: string, factory: any) {
				if (factory) {
					widgets.set(key, factory(tui));
				} else {
					widgets.delete(key);
				}
			},
			custom(factory: any, options: unknown) {
				customOptions.push(options);
				return new Promise((resolve) => {
					let closed = false;
					let component: any;
					const done = (value: unknown) => {
						if (closed) {
							return;
						}
						closed = true;
						tui.children = [editor];
						resolve(value);
						component?.dispose?.();
					};
					component = factory(tui, {}, {}, done);
					tui.children = [component];
					mounts += 1;
				});
			},
		},
	};
	return {
		ctx,
		customOptions,
		tui,
		widgets,
		get mounts() {
			return mounts;
		},
		replaceWithEditor() {
			tui.children = [editor];
			for (const widget of widgets.values()) {
				widget.render();
			}
		},
	};
}

test("a background form remount keeps the controller, draft, and completion callback", async () => {
	const h = harness();
	let created = 0;
	let disposed = 0;
	let draft = "";
	let capturesViewportInput = true;
	let finish: ((result: AskResult) => void) | undefined;
	const running = showPersistentAsk(
		h.ctx as never,
		(_tui, _theme, _keys, done) => {
			created += 1;
			finish = done;
			return {
				get capturesViewportInput() {
					return capturesViewportInput;
				},
				render: () => [draft],
				invalidate: () => undefined,
				handleInput: (data) => {
					draft += data;
				},
				dispose: () => {
					disposed += 1;
				},
			};
		}
	);
	const surface = h.tui.children[0] as {
		capturesViewportInput: boolean;
		handleInput: (data: string) => void;
		render: () => string[];
	};
	assert.equal(surface.capturesViewportInput, true);
	capturesViewportInput = false;
	assert.equal(surface.capturesViewportInput, false);
	capturesViewportInput = true;
	surface.handleInput("saved draft");
	h.replaceWithEditor();
	await tick();
	assert.equal(h.mounts, 2);
	assert.deepEqual(
		h.customOptions.map(
			(options) => (options as { blocked?: unknown })?.blocked
		),
		[
			{ kind: "question", message: "Waiting for user response" },
			{ kind: "question", message: "Waiting for user response" },
		]
	);
	assert.equal(created, 1);
	assert.equal(disposed, 0);
	assert.equal(h.tui.children[0], surface);
	assert.deepEqual(surface.render(), ["saved draft"]);
	assert.equal(surface.capturesViewportInput, true);
	finish?.(answer);
	assert.deepEqual(await running, answer);
	assert.equal(disposed, 1);
	assert.equal(h.widgets.size, 0);
});

test("background surfaces forward mouse events and handled results across remounts", async () => {
	const h = harness();
	const events: TuiMouseEvent[] = [];
	let finish: ((result: AskResult) => void) | undefined;
	const running = showPersistentAsk(
		h.ctx as never,
		(_tui, _theme, _keys, done) => {
			finish = done;
			return {
				render: () => [],
				invalidate: () => undefined,
				handleMouse(event) {
					events.push(event);
					return event.x > 10 ? { handled: true, render: false } : undefined;
				},
			};
		}
	);
	const surface = h.tui.children[0] as Component;
	const wheel: TuiMouseEvent = {
		type: "wheel",
		button: "none",
		x: 20,
		y: 5,
		screenX: 20,
		screenY: 10,
		width: 80,
		height: 20,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta: 3,
	};
	assert.deepEqual(surface.handleMouse?.(wheel), {
		handled: true,
		render: false,
	});
	h.replaceWithEditor();
	await tick();
	assert.equal(h.mounts, 2);
	assert.equal(h.tui.children[0], surface);
	assert.deepEqual(surface.handleMouse?.(wheel), {
		handled: true,
		render: false,
	});
	assert.equal(surface.handleMouse?.({ ...wheel, x: 0 }), undefined);
	assert.equal(events[0], wheel);
	assert.equal(events[1], wheel);
	finish?.(answer);
	assert.deepEqual(await running, answer);
});

test("an answer during a scheduled remount finishes once without reopening", async () => {
	const h = harness();
	let finish: ((result: AskResult) => void) | undefined;
	const running = showPersistentAsk(
		h.ctx as never,
		(_tui, _theme, _keys, done) => {
			finish = done;
			return { render: () => [], invalidate: () => undefined };
		}
	);
	h.replaceWithEditor();
	finish?.(answer);
	assert.deepEqual(await running, answer);
	assert.equal(h.mounts, 1);
	assert.equal(h.widgets.size, 0);
});
