import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import {
	CLIPBOARD_REQUEST_EVENT,
	CLIPBOARD_RESULT_EVENT,
	requestClipboardImage,
} from "../src/clipboard-events.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import { runAskFlow } from "../src/ui/controller.ts";

const image = { mimeType: "image/png", data: "aGVsbG8=" };
const invalidImage = /invalid image|invalid base64|20 MiB/;
const timeoutError = /timed out/;

function eventBus() {
	const emitter = new EventEmitter();
	return {
		emitter,
		emit(channel: string, data: unknown) {
			emitter.emit(channel, data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			emitter.on(channel, handler);
			return () => {
				emitter.off(channel, handler);
			};
		},
	};
}

function provider(status: string, extra: Record<string, unknown> = {}) {
	const bus = eventBus();
	bus.on(CLIPBOARD_REQUEST_EVENT, (request) => {
		bus.emit(CLIPBOARD_RESULT_EVENT, {
			...(request as object),
			status,
			...extra,
		});
	});
	return bus;
}

test("no clipboard provider immediately returns the fallback sentinel and removes listeners", async () => {
	const bus = eventBus();
	assert.equal(
		await requestClipboardImage(bus, new AbortController().signal),
		undefined
	);
	assert.equal(bus.emitter.listenerCount(CLIPBOARD_RESULT_EVENT), 0);
});

test("provider images get Ask-owned ids; empty clipboards do not request fallback", async () => {
	const signal = new AbortController().signal;
	const bus = provider("image", { image });
	const first = await requestClipboardImage(bus, signal);
	const second = await requestClipboardImage(bus, signal);
	assert(first && second);
	assert.deepEqual({ mimeType: first.mimeType, data: first.data }, image);
	assert.notEqual(first.id, second.id);
	assert.equal(bus.emitter.listenerCount(CLIPBOARD_RESULT_EVENT), 0);
	assert.equal(await requestClipboardImage(provider("empty"), signal), null);
});

test("requests correlate replies even when providers finish out of order", async () => {
	const bus = eventBus();
	const requests: object[] = [];
	bus.on(CLIPBOARD_REQUEST_EVENT, (request) => {
		requests.push(request as object);
		bus.emit(CLIPBOARD_RESULT_EVENT, {
			...(request as object),
			status: "reading",
		});
	});
	const signal = new AbortController().signal;
	const first = requestClipboardImage(bus, signal);
	const second = requestClipboardImage(bus, signal);
	bus.emit(CLIPBOARD_RESULT_EVENT, {
		...requests[1],
		status: "image",
		image: { ...image, data: "dHdv" },
	});
	bus.emit(CLIPBOARD_RESULT_EVENT, { ...requests[0], status: "image", image });
	assert.equal((await first)?.data, image.data);
	assert.equal((await second)?.data, "dHdv");
	assert.equal(bus.emitter.listenerCount(CLIPBOARD_RESULT_EVENT), 0);
});

test("Pi\u2019s async-safe event bus preserves a synchronous provider claim", async () => {
	const bus = createEventBus();
	bus.on(CLIPBOARD_REQUEST_EVENT, async (request) => {
		bus.emit(CLIPBOARD_RESULT_EVENT, {
			...(request as object),
			status: "reading",
		});
		await Promise.resolve();
		bus.emit(CLIPBOARD_RESULT_EVENT, {
			...(request as object),
			status: "image",
			image,
		});
	});
	const result = await requestClipboardImage(bus, new AbortController().signal);
	assert.equal(result?.data, image.data);
	bus.clear();
});

test("provider errors and invalid payloads fail instead of bypassing the provider", async () => {
	const signal = new AbortController().signal;
	await assert.rejects(
		requestClipboardImage(
			provider("error", { message: "Read denied" }),
			signal
		),
		{ message: "Read denied" }
	);
	for (const invalid of [
		null,
		{ ...image, mimeType: "image/bmp" },
		{ ...image, data: "" },
		{ ...image, data: "not base64!" },
		{ ...image, data: "aGVsbG9=" },
		{ ...image, data: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64") },
	]) {
		await assert.rejects(
			requestClipboardImage(provider("image", { image: invalid }), signal),
			invalidImage
		);
	}
});

test("claimed requests time out and clean up their result listeners", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const bus = provider("reading");
	const result = requestClipboardImage(bus, new AbortController().signal);
	const rejected = assert.rejects(result, timeoutError);
	t.mock.timers.tick(25_000);
	await rejected;
	assert.equal(bus.emitter.listenerCount(CLIPBOARD_RESULT_EVENT), 0);
});

test("aborted reads clean up and ignore late clipboard results", async () => {
	const bus = provider("reading");
	const abort = new AbortController();
	const result = requestClipboardImage(bus, abort.signal);
	const rejected = assert.rejects(result, { name: "AbortError" });
	abort.abort();
	await rejected;
	assert.equal(bus.emitter.listenerCount(CLIPBOARD_RESULT_EVENT), 0);
	bus.emit(CLIPBOARD_RESULT_EVENT, { version: 1, status: "image", image });
	assert.throws(() => requestClipboardImage(bus, abort.signal), {
		name: "AbortError",
	});
});

test("wrong protocol versions and unrelated replies cannot claim a request", async () => {
	const bus = eventBus();
	bus.on(CLIPBOARD_REQUEST_EVENT, (request) => {
		bus.emit(CLIPBOARD_RESULT_EVENT, {
			...(request as object),
			version: 2,
			status: "reading",
		});
		bus.emit(CLIPBOARD_RESULT_EVENT, {
			version: 1,
			requestId: "other",
			status: "reading",
		});
	});
	assert.equal(
		await requestClipboardImage(bus, new AbortController().signal),
		undefined
	);
});

for (const { label, keys, pasteInput } of [
	{ label: "configured Alt+V", keys: ["alt+v"], pasteInput: "\x1bv" },
	{ label: "remapped Alt+G", keys: ["alt+g"], pasteInput: "\x1bg" },
	{ label: "disabled host binding, Alt+V", keys: [], pasteInput: "\x1bv" },
	{
		label: "disabled host binding, Ctrl+Alt+V",
		keys: [],
		pasteInput: "\x1b\x16",
	},
] as const) {
	test(`Ask routes clipboard bytes and ignores a late reply (${label})`, async () => {
		getAskConfigStore().setConfig({
			...DEFAULT_ASK_CONFIG,
			notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
		});
		const bus = eventBus();
		let reply: (() => void) | undefined;
		bus.on(CLIPBOARD_REQUEST_EVENT, (request) => {
			bus.emit(CLIPBOARD_RESULT_EVENT, {
				...(request as object),
				status: "reading",
			});
			reply = () =>
				bus.emit(CLIPBOARD_RESULT_EVENT, {
					...(request as object),
					status: "image",
					image,
				});
		});
		let finish: ((result: unknown) => void) | undefined;
		let component:
			| {
					handleInput(data: string): void;
					render(width: number): string[];
					dispose(): void;
			  }
			| undefined;
		try {
			const resultPromise = runAskFlow(
				{
					cwd: process.cwd(),
					mode: "tui",
					ui: {
						custom(callback: (...args: unknown[]) => unknown) {
							return new Promise((resolve) => {
								finish = resolve;
								component = callback(
									{
										terminal: { rows: 40 },
										requestRender() {
											// Rendering is not needed to exercise controller input.
										},
									},
									{
										fg: (_color: string, text: string) => text,
										bg: (_color: string, text: string) => text,
										bold: (text: string) => text,
									},
									new KeybindingsManager(
										{
											"app.clipboard.pasteImage": {
												defaultKeys: "alt+v",
												description: "Paste image",
											},
										},
										{ "app.clipboard.pasteImage": [...keys] }
									),
									resolve
								) as typeof component;
							});
						},
					},
				} as never,
				{
					questions: [
						{
							id: "q",
							prompt: "Screenshot?",
							options: [{ value: "a", label: "A" }],
						},
					],
				},
				{ clipboardEvents: bus }
			);
			await new Promise((resolve) => setImmediate(resolve));
			assert(component);
			component.handleInput("2");
			if (keys[0] === "alt+g") {
				component.handleInput("\x1bv");
				assert.equal(
					reply,
					undefined,
					"A configured shortcut must not enable fallback keys"
				);
			}
			component.handleInput(pasteInput);
			assert(
				reply,
				"The paste shortcut must request an image even with the host binding disabled"
			);
			const expectedKeys = keys.length ? keys.join("/") : "alt+v/ctrl+alt+v";
			assert(
				component
					.render(100)
					.join("\n")
					.includes(`${expectedKeys}: attach image`)
			);
			reply();
			await new Promise((resolve) => setImmediate(resolve));
			const firstReply = reply;
			component.handleInput(pasteInput);
			assert.notEqual(
				reply,
				firstReply,
				"The late-reply test must start a second clipboard read"
			);
			component.handleInput("\r");
			reply();
			await new Promise((resolve) => setImmediate(resolve));
			component.handleInput("\r");
			const result = await resultPromise;
			assert.equal(result.answers.q.customImages?.length, 1);
			assert.equal(result.answers.q.customImages?.[0].data, image.data);
			assert.equal(result.answers.q.noteImages, undefined);
			assert.equal(bus.emitter.listenerCount(CLIPBOARD_RESULT_EVENT), 0);
		} finally {
			component?.dispose();
			finish?.({ cancelled: true });
			getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
		}
	});
}
