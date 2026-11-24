import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AskImage } from "./types.ts";

export const CLIPBOARD_REQUEST_EVENT = "pi-agent-ask:clipboard-request";
export const CLIPBOARD_RESULT_EVENT = "pi-agent-ask:clipboard-result";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 25_000;
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
const imageTypes = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseImage(value: unknown): AskImage {
	if (
		!isRecord(value) ||
		typeof value.mimeType !== "string" ||
		!imageTypes.has(value.mimeType) ||
		typeof value.data !== "string" ||
		!value.data.length ||
		value.data.length % 4 !== 0 ||
		value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
		!base64Pattern.test(value.data)
	) {
		throw new Error("Clipboard provider returned an invalid image.");
	}
	const bytes = Buffer.from(value.data, "base64");
	if (bytes.toString("base64") !== value.data) {
		throw new Error("Clipboard provider returned invalid base64 image data.");
	}
	if (bytes.length > MAX_IMAGE_BYTES) {
		throw new Error("Clipboard image exceeds 20 MiB.");
	}
	return { id: randomUUID(), mimeType: value.mimeType, data: value.data };
}

function parseResult(response: Record<string, unknown>): AskImage | null {
	if (response.status === "empty") {
		return null;
	}
	if (response.status === "image") {
		return parseImage(response.image);
	}
	throw new Error(
		response.status === "error" && typeof response.message === "string"
			? response.message
			: "Clipboard provider returned an invalid response."
	);
}

/** Undefined means no provider claimed the request; only then should Ask use its own reader. */
export function requestClipboardImage(
	events: ExtensionAPI["events"],
	signal: AbortSignal
): Promise<AskImage | null | undefined> {
	signal.throwIfAborted();
	const requestId = randomUUID();
	return new Promise((resolve, reject) => {
		let claimed = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			signal.removeEventListener("abort", abort);
		};
		const abort = () => {
			if (!settled) {
				cleanup();
				reject(signal.reason);
			}
		};
		const unsubscribe = events.on(CLIPBOARD_RESULT_EVENT, (response) => {
			if (
				settled ||
				!isRecord(response) ||
				response.version !== 1 ||
				response.requestId !== requestId
			) {
				return;
			}
			claimed = true;
			if (response.status === "reading") {
				return;
			}
			cleanup();
			try {
				resolve(parseResult(response));
			} catch (error) {
				reject(error);
			}
		});
		signal.addEventListener("abort", abort, { once: true });
		try {
			events.emit(CLIPBOARD_REQUEST_EVENT, { version: 1, requestId });
		} catch (error) {
			cleanup();
			reject(error);
			return;
		}
		if (settled) {
			return;
		}
		if (!claimed) {
			cleanup();
			resolve(undefined);
			return;
		}
		timer = setTimeout(() => {
			cleanup();
			reject(new Error("Clipboard provider timed out. Try pasting again."));
		}, PROVIDER_TIMEOUT_MS);
	});
}
