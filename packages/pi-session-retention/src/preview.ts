import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { stripVTControlCharacters } from "node:util";
import type { TrashBatch } from "./core.ts";
import { fileStamp, stamp } from "./search-cache.ts";

export type TrashPreview = {
	name: string; cwd: string; firstRequest: string;
	recent: { role: "user" | "assistant"; text: string }[];
	truncated: boolean;
};
const TEXT_LIMIT = 4000, RECENT_LIMIT = 6, TREE_LIMIT = 100_000, ID_LIMIT = 2 * 1024 * 1024;
const changed = () => new Error("Session changed while reading its preview. Go back and retry.");
const clean = (text: string) => stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");

// Each pass has its own handle: destroying a FileHandle stream may close it even
// with autoClose:false. Verify before destruction, then always drain and close.
async function readPass(path: string, identity: string, signal: AbortSignal, visit: (entry: any) => void): Promise<void> {
	signal.throwIfAborted();
	if (await fileStamp(path) !== identity) throw changed();
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (stamp(await handle.stat({ bigint: true })) !== identity) throw changed();
		signal.throwIfAborted();
		const stream = handle.createReadStream({ autoClose: false, signal });
		let streamError: unknown;
		const drained = finished(stream).catch(error => { streamError = error; });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				signal.throwIfAborted();
				if (line.length > 16 * 1024 * 1024) throw new Error("Preview unavailable: a transcript entry exceeds 16 MiB");
				let entry;
				try { entry = JSON.parse(line); } catch { continue; }
				if (entry && typeof entry === "object" && typeof entry.type === "string") visit(entry);
			}
			signal.throwIfAborted();
			if (stamp(await handle.stat({ bigint: true })) !== identity || await fileStamp(path) !== identity) throw changed();
		} finally { lines.close(); stream.destroy(); await drained; }
		signal.throwIfAborted();
		if (streamError) throw streamError;
	} finally { await handle.close(); }
}

/** Bounded excerpts from one selected member, never an active SessionManager. */
export async function loadTrashPreview(trashRoot: string, batch: TrashBatch, memberIndex: number, signal: AbortSignal): Promise<TrashPreview> {
	signal.throwIfAborted();
	const manifest = structuredClone(batch.manifest);
	const file = manifest?.files?.[memberIndex];
	if (!manifest || manifest.version !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(manifest.id) ||
		!Number.isInteger(memberIndex) || memberIndex < 0 || !file || file.stored !== `${memberIndex}.jsonl` ||
		typeof file.original !== "string" || !file.original.endsWith(".jsonl") || file.original.includes("\\") ||
		file.original.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) throw new Error("Invalid Trash preview path or member");
	if (batch.missing.includes(file.stored)) throw new Error("Session file is missing from Trash");
	const path = join(resolve(trashRoot), manifest.id, file.stored), identity = await fileStamp(path);
	const result: TrashPreview = { name: "", cwd: "", firstRequest: "", recent: [], truncated: false };
	const clip = (text: string) => {
		if (text.length > TEXT_LIMIT) result.truncated = true;
		const value = clean(text.slice(0, TEXT_LIMIT + 1));
		if (value.length > TEXT_LIMIT) result.truncated = true;
		return value.slice(0, TEXT_LIMIT).replace(/[\uD800-\uDBFF]$/, "");
	};
	const parents = new Map<string, string | null>();
	let leaf: string | null = null, idSize = 0, tree = false, idlessMessages = false;
	await readPass(path, identity, signal, entry => {
		if (entry.type === "session") {
			if (typeof entry.cwd === "string") result.cwd = clip(entry.cwd);
			if (typeof entry.version === "number" && entry.version >= 2) tree = true;
			return;
		}
		if (entry.type === "session_info" && typeof entry.name === "string") result.name = clip(entry.name);
		if (typeof entry.id !== "string") {
			if (entry.type === "message") idlessMessages = true;
			return;
		}
		tree = true;
		if (!entry.id || entry.id.length > 256 || (entry.parentId !== null && (typeof entry.parentId !== "string" || entry.parentId.length > 256)) || parents.has(entry.id)) throw new Error("Cannot verify the session preview branch");
		idSize += entry.id.length + (entry.parentId?.length ?? 0);
		if (parents.size >= TREE_LIMIT || idSize > ID_LIMIT) throw new Error("Preview unavailable: session tree exceeds the preview limit");
		parents.set(entry.id, entry.parentId);
		leaf = entry.id;
	});
	if (tree && idlessMessages) throw new Error("Cannot verify mixed linear/tree session entries");
	const branch = new Set<string>();
	while (leaf !== null) {
		if (branch.has(leaf) || !parents.has(leaf)) throw new Error("Cannot verify the session preview branch");
		branch.add(leaf);
		leaf = parents.get(leaf)!;
	}
	let firstUser = false;
	await readPass(path, identity, signal, entry => {
		if (entry.type !== "message" || (tree && !branch.has(entry.id))) return;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") return;
		const content = entry.message.content;
		const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
		let text = "";
		for (const [index, part] of parts.entries()) {
			const value = part?.type === "text" && typeof part.text === "string" ? part.text : "";
			if (!value) continue;
			text = clip(text + (text ? "\n" : "") + clip(value));
			if (text.length >= TEXT_LIMIT) {
				if (parts.slice(index + 1).some(part => part?.type === "text" && part.text)) result.truncated = true;
				break;
			}
		}
		if (role === "user" && !firstUser) { result.firstRequest = text; firstUser = true; }
		if (text.trim()) result.recent.push({ role, text });
		if (result.recent.length > RECENT_LIMIT) { result.recent.shift(); result.truncated = true; }
	});
	signal.throwIfAborted();
	if (await fileStamp(path) !== identity) throw changed();
	return result;
}
