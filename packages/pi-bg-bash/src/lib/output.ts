import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

/** Logs are untrusted terminal input; keep text, never terminal control sequences. */
export function cleanOutput(text: string): string {
	return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/\t/g, "    ");
}

export function oneLine(text: string): string {
	return cleanOutput(text).replace(/\s+/g, " ").trim();
}

/** Read only a bounded suffix, including for a single enormous log line. */
export function readTail(path: string, maxLines = 2000, maxBytes = 48 * 1024): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const buffer = Buffer.alloc(Math.min(size, maxBytes));
		const count = readSync(fd, buffer, 0, buffer.length, start);
		const text = cleanOutput(buffer.subarray(0, count).toString("utf8"));
		const lines = text.split("\n");
		const cut = start > 0 || lines.length > maxLines;
		return (cut ? "(earlier output omitted)\n" : "") + lines.slice(-maxLines).join("\n").trimEnd();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "(no output yet)" : "(output unavailable)";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
