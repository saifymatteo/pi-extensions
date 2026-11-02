/**
 * clipboard-image.ts — attach a clipboard image to the draft with Alt+V.
 *
 * Why this exists instead of `@pi-archimedes/image-paste`: on Windows that
 * package only ever reads a *bitmap* from the clipboard. Copying an image
 * *file* in Explorer puts `FileDrop`/`FileContents` on the clipboard with no
 * bitmap (`Clipboard.ContainsImage()` is False), so Alt+V answered
 * "No image found in clipboard." forever. Windows Terminal then forwards
 * Ctrl+V as a bracketed paste of the file path, which pi tries to read as a
 * file — and guardrails blocks it when the file lives outside `allowedPaths`
 * (e.g. a screenshot on another drive).
 *
 * This extension reads whatever the clipboard actually holds, on Windows and
 * WSL via one PowerShell -STA call. It attaches image bytes through the `input`
 * transform and appends the temp-file path to the submitted text so vision-tools
 * CLIs can access the image. macOS uses pi-tui's bundled native helper; native
 * Linux tries wl-paste/xclip first and falls back to that helper.
 *
 * Alt+V                     attach the clipboard image (bitmap or image file)
 * Ctrl+Alt+V                same
 * Delete the `[Image #N]`   marker before sending to drop that image.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { convertToPng, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard, type KeyId } from "@earendil-works/pi-tui";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB, matches the rest of the image pipeline
const PS_TIMEOUT_MS = 8000;
const PS_MAX_STDOUT_BYTES = 40 * 1024 * 1024; // base64 of a >20 MiB image; the size guard rejects it after decode
const PS_ATTEMPTS = 2;
const PS_RETRY_DELAY_MS = 180;
const LINUX_LIST_TIMEOUT_MS = 1000;
const LINUX_READ_TIMEOUT_MS = 5000;
const COMMAND_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"] as const;

interface ClipboardImage {
	bytes: Uint8Array;
	mimeType: string;
}

interface PendingImage {
	id: string;
	base64: string;
	path: string;
	mimeType: string;
	marker: string;
}

// ── Windows reader (bitmap OR file drop) ────────────────────────────────────

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -ne $img) {
  $ms = New-Object System.IO.MemoryStream
  try {
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ('IMG:' + [System.Convert]::ToBase64String($ms.ToArray()))
  } finally {
    $ms.Dispose()
    $img.Dispose()
  }
  exit 0
}

if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  foreach ($f in [System.Windows.Forms.Clipboard]::GetFileDropList()) {
    $ext = [System.IO.Path]::GetExtension($f).ToLowerInvariant()
    if ('.png','.jpg','.jpeg','.webp','.gif','.bmp' -contains $ext) {
      if (Test-Path -LiteralPath $f) {
        $b = [System.IO.File]::ReadAllBytes($f)
        Write-Output ('FILE:' + $ext + ':' + [System.Convert]::ToBase64String($b))
        exit 0
      }
    }
  }
}

$o = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($null -ne $o -and $o.GetDataPresent('FileContents')) {
  $s = $o.GetData('FileContents')
  if ($s -is [System.IO.Stream]) {
    $ms = New-Object System.IO.MemoryStream
    $s.CopyTo($ms)
    Write-Output ('STREAM:' + [System.Convert]::ToBase64String($ms.ToArray()))
    exit 0
  }
}

Write-Output 'NONE'
`;

const EXTENSION_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectMime(bytes: Uint8Array): string {
	if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		return "image/gif";
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "image/bmp";
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return "image/png";
}

function decodeBase64(data: string, mimeType: string | null): ClipboardImage | null {
	try {
		const bytes = Uint8Array.from(Buffer.from(data, "base64"));
		if (bytes.length === 0) return null;
		return { bytes, mimeType: mimeType ?? detectMime(bytes) };
	} catch {
		return null;
	}
}

function parsePowerShellOutput(out: string | null): ClipboardImage | null {
	if (!out || out === "NONE") return null;

	if (out.startsWith("IMG:")) {
		return decodeBase64(out.slice(4), "image/png");
	}
	if (out.startsWith("STREAM:")) {
		return decodeBase64(out.slice(7), null);
	}
	if (out.startsWith("FILE:")) {
		const rest = out.slice(5);
		const sep = rest.indexOf(":");
		if (sep < 0) return null;
		const ext = rest.slice(0, sep).toLowerCase();
		return decodeBase64(rest.slice(sep + 1), EXTENSION_MIME[ext] ?? null);
	}
	return null;
}

/** Run the PowerShell snippet once. Resolves stdout on success, null on any failure/timeout. */
function runPowerShell(script: string): Promise<string | null> {
	return new Promise((resolve) => {
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-EncodedCommand", encoded],
			{ windowsHide: true },
		);

		let stdout = "";
		let bytes = 0;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (value: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};

		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, PS_TIMEOUT_MS);

		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > PS_MAX_STDOUT_BYTES) return;
			stdout += chunk.toString("utf8");
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code === 0 ? stdout.trim() : null));
	});
}

/**
 * Read the Windows clipboard, retrying once because a screenshot app can still
 * hold the clipboard open (CLIPBRD_E_CANT_OPEN) for a moment after Win+Shift+S.
 */
async function readWindowsClipboard(): Promise<ClipboardImage | null> {
	for (let attempt = 0; attempt < PS_ATTEMPTS; attempt++) {
		if (attempt > 0) await sleep(PS_RETRY_DELAY_MS);
		const image = parsePowerShellOutput(await runPowerShell(PS_SCRIPT));
		if (image) return image;
	}
	return null;
}

// ── macOS / Linux native fallback (pi-tui native clipboard helper) ──────────

async function readNativeClipboard(): Promise<ClipboardImage | null> {
	try {
		const native = getNativeClipboard();
		const raw = await native?.getImage?.();
		if (!raw || raw.length === 0) return null;
		const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
		return { bytes, mimeType: "image/png" };
	} catch {
		return null;
	}
}

// ── Linux clipboard tools (wl-paste / xclip) ────────────────────────────────

interface CommandResult {
	ok: boolean;
	stdout: Buffer;
}

function runCommand(command: string, args: string[], timeout: number): CommandResult {
	const result = spawnSync(command, args, { timeout, maxBuffer: COMMAND_MAX_BUFFER_BYTES });
	if (result.error) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}
	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(typeof result.stdout === "string" ? result.stdout : "");
	return { ok: result.status === 0, stdout };
}

function normalizeMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function selectPreferredImageMimeType(mimeTypes: readonly string[]): string | null {
	const normalized = mimeTypes
		.map((mimeType) => mimeType.trim())
		.filter((mimeType) => mimeType.length > 0)
		.map((raw) => ({ raw, normalized: normalizeMimeType(raw) }));
	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((entry) => entry.normalized === preferred);
		if (match) return match.raw;
	}
	return normalized.find((entry) => entry.normalized.startsWith("image/"))?.raw ?? null;
}

function readViaWlPaste(): ClipboardImage | null {
	const list = runCommand("wl-paste", ["--list-types"], LINUX_LIST_TIMEOUT_MS);
	if (!list.ok) return null;

	const mimeTypes = list.stdout
		.toString("utf8")
		.split(/\r?\n/)
		.map((mimeType) => mimeType.trim())
		.filter(Boolean);
	const selected = selectPreferredImageMimeType(mimeTypes);
	if (!selected) return null;

	const data = runCommand("wl-paste", ["--type", selected, "--no-newline"], LINUX_READ_TIMEOUT_MS);
	if (!data.ok || data.stdout.length === 0) return null;
	return { bytes: new Uint8Array(data.stdout), mimeType: normalizeMimeType(selected) };
}

function readViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], LINUX_LIST_TIMEOUT_MS);
	const advertised = targets.ok
		? targets.stdout
				.toString("utf8")
				.split(/\r?\n/)
				.map((mimeType) => mimeType.trim())
				.filter(Boolean)
		: [];

	const preferred = advertised.length > 0 ? selectPreferredImageMimeType(advertised) : null;
	const mimeTypesToTry = preferred
		? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES]
		: [...SUPPORTED_IMAGE_MIME_TYPES];

	for (const mimeType of mimeTypesToTry) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"], LINUX_READ_TIMEOUT_MS);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: new Uint8Array(data.stdout), mimeType: normalizeMimeType(mimeType) };
		}
	}
	return null;
}

/** wl-paste or xclip first (whichever matches the session), then the native helper. */
function readLinuxClipboard(): ClipboardImage | null {
	const wayland =
		Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland";
	const readers = wayland ? [readViaWlPaste, readViaXclip] : [readViaXclip, readViaWlPaste];
	for (const reader of readers) {
		const image = reader();
		if (image) return image;
	}
	return null;
}

/**
 * Windows and WSL both read the Windows clipboard; on WSL that means shelling
 * out to powershell.exe (the Linux clipboard tools cannot see Windows
 * screenshots). The base64 round-trip avoids the WSL file-bridge race that
 * plagued pi's own fallback.
 */
function usesWindowsClipboard(): boolean {
	return process.platform === "win32" || Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

async function readClipboardImage(): Promise<ClipboardImage | null> {
	if (usesWindowsClipboard()) return readWindowsClipboard();
	if (process.platform === "linux") {
		const viaTools = readLinuxClipboard();
		if (viaTools) return viaTools;
	}
	return readNativeClipboard();
}

// ── Extension ───────────────────────────────────────────────────────────────

// Alt+V and Ctrl+Alt+V on every platform. Ctrl+V is deliberately left to the
// terminal/built-in path paste so it can still forward non-image text.
const PASTE_SHORTCUTS = ["alt+v", "ctrl+alt+v"] as KeyId[];

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | null = null;
	let pending: PendingImage[] = [];
	let nextIndex = 1;
	let pasting = false;
	// This bridge is independent of the draft attachment queue and UI context.
	const clipboardReads = new Set<(result: ClipboardBridgeResult) => void>();
	type ClipboardBridgeResult =
		| { status: "image"; image: { mimeType: string; data: string } }
		| { status: "empty" }
		| { status: "error"; message: string };
	const handleClipboardRequest = async (payload: unknown): Promise<void> => {
		if (!payload || typeof payload !== "object") return;
		const request = payload as { version?: unknown; requestId?: unknown };
		if (request.version !== 1 || typeof request.requestId !== "string" || !request.requestId.trim()) return;
		const requestId = request.requestId;
		const finish = (result: ClipboardBridgeResult): void => {
			if (!clipboardReads.delete(finish)) return;
			pi.events.emit("pi-agent-ask:clipboard-result", { version: 1, requestId, ...result });
		};
		clipboardReads.add(finish);
		// Presence detection requires this acknowledgement before the first await/read.
		pi.events.emit("pi-agent-ask:clipboard-result", { version: 1, requestId, status: "reading" });
		if (!clipboardReads.has(finish)) return;
		try {
			const image = await readClipboardImage();
			if (!clipboardReads.has(finish)) return;
			if (!image || image.bytes.length === 0) {
				finish({ status: "empty" });
				return;
			}
			if (image.bytes.length > MAX_IMAGE_BYTES) throw new Error("Clipboard image exceeds 20 MiB.");
			const mimeType = normalizeMimeType(image.mimeType);
			let result = { mimeType, data: Buffer.from(image.bytes).toString("base64") };
			if (mimeType === "image/bmp") {
				const converted = await convertToPng(result.data, mimeType);
				if (!converted || converted.mimeType !== "image/png") throw new Error("Clipboard BMP conversion failed.");
				const size = Buffer.from(converted.data, "base64").length;
				if (!size || size > MAX_IMAGE_BYTES) throw new Error("Converted clipboard image is empty or exceeds 20 MiB.");
				result = converted;
			} else if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) {
				throw new Error(`Unsupported clipboard image MIME type: ${mimeType}`);
			}
			finish({ status: "image", image: result });
		} catch (error) {
			finish({ status: "error", message: error instanceof Error ? error.message : String(error) });
		}
	};
	// Register now, not in session_start: consumers can load before this extension.
	let unsubscribeClipboard: (() => void) | undefined = pi.events.on("pi-agent-ask:clipboard-request", handleClipboardRequest);
	const tempFiles = new Set<string>();
	const removeTempFile = (path: string): void => {
		try {
			unlinkSync(path);
		} catch {
			// The file may already have been removed.
		}
		tempFiles.delete(path);
	};
	const cleanTempFiles = (): void => {
		for (const path of tempFiles) removeTempFile(path);
	};

	const attachFromClipboard = async (): Promise<void> => {
		if (pasting || !ctx || !ctx.hasUI) return;
		pasting = true;
		try {
			const image = await readClipboardImage();

			if (!image) {
				ctx.ui.notify(
					"No image on the clipboard. Copy a screenshot (Win+Shift+S) or an image file, then Alt+V.",
					"warning",
				);
				return;
			}
			if (image.bytes.length === 0) {
				ctx.ui.notify("Clipboard image is empty (0 bytes).", "warning");
				return;
			}
			if (image.bytes.length > MAX_IMAGE_BYTES) {
				ctx.ui.notify(
					`Image too large (${(image.bytes.length / 1024 / 1024).toFixed(1)} MB > 20 MB).`,
					"warning",
				);
				return;
			}

			// Write to temp file for vision-tools CLI access
			try {
				const ext = image.mimeType.split("/")[1] || "png";
				const filename = `clipboard-${Date.now()}-${randomUUID()}.${ext}`;
				const tempDir = join(tmpdir(), "pi-clipboard-images");
				mkdirSync(tempDir, { recursive: true });
				const tempPath = join(tempDir, filename);

				const buffer = Buffer.from(image.bytes);
				const base64 = buffer.toString("base64");
				writeFileSync(tempPath, buffer);
				tempFiles.add(tempPath);

				const index = nextIndex++;
				const marker = `[Image #${index}] `;
				pending.push({
					id: randomUUID(),
					base64,
					path: tempPath,
					mimeType: image.mimeType,
					marker,
				});
				ctx.ui.pasteToEditor(marker);
				ctx.ui.notify(`Image #${index} attached — send the message to include it.`, "info");
			} catch (writeError) {
				const msg = writeError instanceof Error ? writeError.message : String(writeError);
				ctx.ui.notify(`Failed to write image file: ${msg}`, "error");
				return;
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Image paste failed: ${msg}`, "warning");
		} finally {
			pasting = false;
		}
	};

	for (const shortcut of PASTE_SHORTCUTS) {
		pi.registerShortcut(shortcut, {
			description: "Attach clipboard image to draft",
			handler: attachFromClipboard,
		});
	}

	// Attach queued images on submit. Markers are the source of truth: delete
	// `[Image #N]` and that image is not sent.
	pi.on("input", (event) => {
		if (event.source === "extension" || pending.length === 0) {
			return { action: "continue" as const };
		}

		const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
		const submittedPaths: string[] = [];
		for (const item of pending) {
			if (event.text.includes(item.marker.trim())) {
				images.push({ type: "image" as const, data: item.base64, mimeType: item.mimeType });
				submittedPaths.push(item.path);
			} else {
				removeTempFile(item.path);
			}
		}

		pending = [];
		nextIndex = 1;

		if (images.length === 0) {
			return { action: "continue" as const };
		}
		const pathsText = submittedPaths.map((path, idx) => `Image #${idx + 1}: ${path}`).join("\n");
		const text = pathsText ? `${event.text}\n${pathsText}` : event.text;
		return { action: "transform" as const, text, images };
	});

	pi.on("session_start", (_event, sessionCtx) => {
		if (!unsubscribeClipboard) {
			unsubscribeClipboard = pi.events.on("pi-agent-ask:clipboard-request", handleClipboardRequest);
		}
		cleanTempFiles();
		ctx = sessionCtx;
		pending = [];
		nextIndex = 1;
		pasting = false;
	});

	pi.on("session_shutdown", () => {
		unsubscribeClipboard?.();
		unsubscribeClipboard = undefined;
		for (const finish of clipboardReads) {
			finish({ status: "error", message: "Clipboard provider session shut down." });
		}
		cleanTempFiles();
		ctx = null;
		pending = [];
		nextIndex = 1;
		pasting = false;
	});
}
