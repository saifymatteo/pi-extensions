import { vi } from "vitest";
import type { SidebarPanelEventTransport } from "../../src/sidebar-panels.js";

export function eventTransport(
	options: { throwOnEventSubscribe?: readonly string[]; throwOnEventUnsubscribe?: readonly string[] } = {},
) {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const emitted: unknown[] = [];
	const events = {
		on: vi.fn((channel: string, handler: (data: unknown) => void) => {
			if (options.throwOnEventSubscribe?.includes(channel)) throw new Error(`subscribe failed: ${channel}`);
			const handlers = listeners.get(channel) ?? new Set();
			handlers.add(handler);
			listeners.set(channel, handlers);
			return () => {
				if (options.throwOnEventUnsubscribe?.includes(channel))
					throw new Error(`unsubscribe failed: ${channel}`);
				handlers.delete(handler);
			};
		}),
		emit: vi.fn((channel: string, data: unknown) => {
			emitted.push(data);
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
		}),
	} satisfies SidebarPanelEventTransport;
	return { events, emitted, listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0 };
}
