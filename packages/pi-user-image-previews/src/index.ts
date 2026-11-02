/**
 * Collapsible inline previews for newly submitted user attachments (Pi 1.3+).
 * Independent borderless image rows; Ctrl+O expands/collapses all previews.
 * UI-only entries reference the original message: no duplicate image payloads,
 * model messages, tool calls, or dependence on clipboard temp files.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, getImageDimensions, Image, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";

const PREVIEW_TYPE = "user-image-preview";

function messageId(data: unknown): string | undefined {
	return data !== null && typeof data === "object" && "messageId" in data && typeof data.messageId === "string"
		? data.messageId : undefined;
}

export default function (pi: ExtensionAPI) {
	let retired = false;
	let sessionManager: ExtensionContext["sessionManager"] | undefined;
	const disclosures = new Map<string, { images: Set<number>; expanded: boolean }>();
	// undefined = no new prompt; null = the prompt started an empty branch.
	let pendingAfter: string | null | undefined;

	pi.on("session_start", (_event, ctx) => {
		retired = false;
		sessionManager = ctx.sessionManager;
		disclosures.clear();
		pendingAfter = undefined;
	});
	pi.on("session_shutdown", () => {
		// The TUI may still render/rebuild old rows while /reload is replacing
		// the runtime. Those callbacks must not touch its now-stale pi or ctx.
		retired = true;
		sessionManager = undefined;
		pendingAfter = undefined;
		disclosures.clear();
	});
	pi.on("agent_settled", () => { pendingAfter = undefined; });

	pi.on("message_end", (event, ctx) => {
		if (ctx.mode === "tui" && event.message.role === "user" && pendingAfter === undefined) {
			pendingAfter = ctx.sessionManager.getLeafId();
		}
	});

	pi.on("context", (_event, ctx) => {
		if (ctx.mode !== "tui" || pendingAfter === undefined) return;
		sessionManager = ctx.sessionManager;
		const branch = sessionManager.getBranch();
		const start = pendingAfter === null ? 0 : branch.findIndex((entry) => entry.id === pendingAfter) + 1;
		if (pendingAfter !== null && start === 0) {
			pendingAfter = undefined; // The branch changed; never backfill unrelated history.
			return;
		}
		const previewed = new Set(branch.flatMap((entry) =>
			entry.type === "custom" && entry.customType === PREVIEW_TYPE ? [messageId(entry.data)] : [],
		));
		// In Pi 1.3, message_end precedes persistence. At this boundary the
		// finalized user message is saved and displayed, but the LLM has not started.
		// Use entry IDs, not message object identity: other extensions can replace messages.
		for (const entry of branch.slice(start)) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			if (Array.isArray(content) && content.some((block) => block.type === "image") &&
				!previewed.has(entry.id) && pi.getSettings().terminal?.showImages !== false) {
				pi.appendEntry(PREVIEW_TYPE, { messageId: entry.id });
			}
		}
		pendingAfter = undefined;
	});

	pi.registerEntryRenderer(PREVIEW_TYPE, function renderPreview(entry, options, theme): Component | undefined {
		if (retired) return;
		const id = messageId(entry.data);
		const terminal = pi.getSettings().terminal;
		if (!id || terminal?.showImages === false) return;
		if (!sessionManager) {
			// /reload rebuilds history before session_start. Returning undefined
			// here makes Pi discard this entry; retain it and resolve on render.
			let content: Component | undefined;
			return {
				render(width) {
					if (retired) return [];
					if (sessionManager) content ??= renderPreview(entry, options, theme);
					return content?.render(width) ?? [];
				},
				handleMouse: (event) => retired ? undefined : content?.handleMouse?.(event),
				invalidate: () => { if (!retired) content?.invalidate(); },
			};
		}
		const source = sessionManager.getEntry(id);
		if (source?.type !== "message" || source.message.role !== "user") return;
		const content = source.message.content;
		const images = Array.isArray(content) ? content.filter((block) => block.type === "image") : [];
		if (images.length === 0) return;

		// Keep UI state outside the component: Pi recreates it on invalidation and Ctrl+O.
		let state = disclosures.get(entry.id);
		if (!state) {
			state = { images: new Set(), expanded: options.expanded };
			disclosures.set(entry.id, state);
			if (options.expanded) images.forEach((_image, index) => state!.images.add(index));
		} else if (state.expanded !== options.expanded) {
			state.expanded = options.expanded;
			state.images.clear();
			if (options.expanded) images.forEach((_image, index) => state!.images.add(index));
		}
		const disclosure = state;
		const previews = images.map((image) => {
			const dimensions = getImageDimensions(image.data, image.mimeType);
			// Native Image fits to available columns; cap at natural width to avoid upscaling.
			const naturalWidth = dimensions
				? Math.max(1, Math.floor(dimensions.widthPx / getCellDimensions().widthPx)) : 60;
			return {
				dimensions,
				image: new Image(image.data, image.mimeType, {
					fallbackColor: (text) => theme.fg("dim", text),
				}, {
					maxWidthCells: Math.min(naturalWidth, terminal?.imageWidthCells ?? naturalWidth),
					maxHeightCells: Number.MAX_SAFE_INTEGER, // Do not shrink tall images into a square.
				}, dimensions ?? undefined),
			};
		});
		let headers = new Map<number, number>();
		let renderedWidth = 0;
		let renderedHeight = 0;
		const preview = {
			render(width: number): string[] {
				headers = new Map();
				renderedWidth = width;
				renderedHeight = 0;
				if (retired || width < 1 || pi.getSettings().terminal?.showImages === false) return [];
				const lines: string[] = [];
				for (const [index, child] of previews.entries()) {
					const open = disclosure.images.has(index);
					const size = child.dimensions;
					headers.set(lines.length, index);
					// nf-fa-file_image
					lines.push(theme.fg("dim", truncateToWidth(`${open ? "\uf0d7" : "\uf0da"} \uf1c5 Image #${index + 1}${size ? ` · ${size.widthPx}×${size.heightPx}` : ""}`, width, "")));
					// Native Image owns sizing, colors, protocol payloads and cursor positioning.
					if (open) lines.push(...child.image.render(width));
				}
				renderedHeight = lines.length;
				return lines;
			},
			handleMouse(event: TuiMouseEvent) {
				if (retired || event.type !== "click" || event.button !== "left" ||
					event.x < 0 || event.x >= renderedWidth || event.y < 0 || event.y >= renderedHeight) return;
				const index = headers.get(event.y);
				if (index !== undefined) {
					if (disclosure.images.has(index)) disclosure.images.delete(index);
					else disclosure.images.add(index);
				}
				if (index !== undefined) preview.invalidate();
				// EntryRenderer has no injected TUI context. The mouse-result contract
				// asks the host to requestRender without capturing selection drags/wheels.
				return { handled: true, render: index !== undefined };
			},
			invalidate() {
				headers.clear();
				renderedHeight = 0;
				if (!retired) for (const child of previews) child.image.invalidate();
			},
		};
		return preview;
	});
}
