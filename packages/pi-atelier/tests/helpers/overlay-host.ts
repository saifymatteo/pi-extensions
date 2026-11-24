import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { deferred } from "./async.js";
import { plainTheme } from "./render.js";

export function fakeTui(requestRender = vi.fn()) {
	return {
		render: vi.fn((width: number) => [`main:${width}`]),
		requestRender,
		terminal: { columns: 120, rows: 36, width: 120, write: vi.fn() },
	};
}

type TestTui = ReturnType<typeof fakeTui>;
type CustomOptions = NonNullable<Parameters<ExtensionContext["ui"]["custom"]>[1]>;
interface OverlayComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

/** Minimal synchronous Pi custom-dialog host; real renderer contracts use the real Pi TUI. */
export function overlayHost(getTui: () => TestTui = fakeTui, interactive = true) {
	const overlays: Array<{
		component: OverlayComponent;
		done: ReturnType<typeof vi.fn<(value?: unknown) => void>>;
		closed: boolean;
		handle: { hide: ReturnType<typeof vi.fn> };
		options: CustomOptions;
		layout: () => import("@earendil-works/pi-tui").OverlayOptions | undefined;
		requestRender: TestTui["requestRender"];
		tui: TestTui;
	}> = [];
	type Overlay = (typeof overlays)[number];
	const mounted = new Map<number, ReturnType<typeof deferred<Overlay>>>();
	const custom = vi.fn(
		(
			factory: (
				tui: TestTui,
				theme: typeof plainTheme & { name: string },
				keys: object,
				done: (value?: unknown) => void,
			) => OverlayComponent,
			options: CustomOptions = {},
		) => {
			const tui = getTui();
			const pending = deferred<unknown>();
			let closed = false;
			const done = vi.fn((value?: unknown) => {
				if (closed) return;
				closed = true;
				pending.resolve(value);
			});
			const handle = { hide: vi.fn() };
			const component = factory(tui, { ...plainTheme, name: "dark" }, {}, done);
			tui.requestRender.mockClear();
			const layout = () =>
				typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
			const overlay = {
				component,
				done,
				get closed() {
					return closed;
				},
				handle,
				options,
				layout,
				requestRender: tui.requestRender,
				tui,
			};
			overlays.push(overlay);
			options.onHandle?.(handle as unknown as OverlayHandle);
			mounted.get(overlays.length - 1)?.resolve(overlay);
			if (!layout()?.nonCapturing && !interactive) done();
			return pending.promise;
		},
	);
	return {
		custom,
		overlays,
		async mounted(index: number): Promise<Overlay> {
			if (overlays[index]) return overlays[index];
			const signal = mounted.get(index) ?? deferred<Overlay>();
			mounted.set(index, signal);
			return signal.promise;
		},
	};
}
