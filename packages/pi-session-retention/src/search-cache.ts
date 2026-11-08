import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { regular, safePath, type TrashBatch } from "./core.ts";
import { safeDirectory } from "./safety.ts";

export type TrashSearchText = { search: string; title: string; cwd?: string };
const VERSION = 1;
const CACHE_BYTES = 8 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cleanText = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
export const stamp = (s: BigIntStats) => {
	const values = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs];
	if (values.some(value => typeof value !== "bigint")) throw new Error("Cannot verify Trash file identity or timestamp precision");
	return values.map(String).join(":");
};
const changed = () => new Error("Trash files changed while reading search metadata");

// regular checks every ancestor without creating anything. Use nanoseconds for
// the fingerprint, including ctime so restoring mtime cannot hide an edit.
export async function fileStamp(path: string): Promise<string> {
	await regular(path);
	const s = await lstat(path, { bigint: true });
	if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Unsafe Trash file: ${path}`);
	return stamp(s);
}

export class TrashSearchCache {
	private readonly root: string;
	private readonly directory: string;
	constructor(trashRoot: string) {
		this.root = resolve(trashRoot);
		this.directory = join(this.root, ".search-cache");
	}

	async read(batch: TrashBatch, signal: AbortSignal): Promise<TrashSearchText> {
		signal.throwIfAborted();
		// Snapshot caller-owned metadata before yielding. No cache-provided path is
		// ever used to open a transcript, even when the cache is otherwise valid.
		const manifest = structuredClone(batch.manifest), missing = [...batch.missing];
		if (!manifest || manifest.version !== 1 || !uuid.test(manifest.id) || typeof manifest.ready !== "boolean" ||
			!Number.isFinite(manifest.trashedAt) || manifest.trashedAt < 0 || !Array.isArray(manifest.files) || !manifest.files.length ||
			missing.some(item => typeof item !== "string")) throw new Error("Invalid Trash manifest");
		for (const [i, file] of manifest.files.entries()) {
			if (!file || file.stored !== `${i}.jsonl` || typeof file.original !== "string" ||
				!file.original.endsWith(".jsonl") || file.original.includes("\\") ||
				file.original.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) throw new Error("Invalid Trash path");
		}
		const missingFiles = new Set(missing);
		const paths = manifest.files.map(file => join(this.root, manifest.id, file.stored));
		const snapshot = async () => {
			const stamps: (string | null)[] = [];
			for (const [i, path] of paths.entries()) {
				signal.throwIfAborted();
				let value: string | null;
				try { value = await fileStamp(path); } catch (error) { if (!absent(error)) throw error; value = null; }
				if ((value === null) !== missingFiles.has(manifest.files[i].stored)) throw changed();
				stamps.push(value);
			}
			return stamps;
		};
		const before = await snapshot();
		const fingerprint = createHash("sha256").update(JSON.stringify({ manifest, missing, stamps: before })).digest("hex");
		const verify = async () => {
			if (JSON.stringify(await snapshot()) !== JSON.stringify(before)) throw changed();
			signal.throwIfAborted();
		};
		const cached = await this.cached(manifest.id, fingerprint);
		if (cached) { await verify(); return cached; }

		const values = [manifest.id, ...manifest.files.map(file => file.original)], labels: string[] = [];
		let cwd: string | undefined;
		for (const [i, path] of paths.entries()) {
			signal.throwIfAborted();
			if (before[i] === null) continue;
			if (await fileStamp(path) !== before[i]) throw changed();
			const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				if (stamp(await handle.stat({ bigint: true })) !== before[i]) throw changed();
				signal.throwIfAborted();
				const stream = handle.createReadStream({ autoClose: false, signal });
				// Attach the drain/error observer before abort can destroy the stream.
				let streamError: unknown;
				const drained = finished(stream).catch(error => { streamError = error; });
				const lines = createInterface({ input: stream, crlfDelay: Infinity });
				let name = "", firstPrompt: string | undefined, fileCwd: string | undefined;
				try {
					for await (const line of lines) {
						signal.throwIfAborted();
						let entry;
						try { entry = JSON.parse(line); } catch { continue; }
						if (!entry || typeof entry !== "object") continue;
						if (entry.type === "session") { values.push(entry.id ?? "", entry.cwd ?? ""); if (fileCwd === undefined && typeof entry.cwd === "string") fileCwd = entry.cwd; }
						if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
						if (firstPrompt === undefined && entry.type === "message" && entry.message?.role === "user") {
							const content = entry.message.content;
							firstPrompt = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join(" ") : "";
						}
					}
					signal.throwIfAborted();
					if (stamp(await handle.stat({ bigint: true })) !== before[i] || await fileStamp(path) !== before[i]) throw changed();
				} finally { lines.close(); stream.destroy(); await drained; }
				signal.throwIfAborted();
				if (streamError) throw streamError;
				values.push(name, firstPrompt ?? "");
				if (cwd === undefined && fileCwd !== undefined) cwd = fileCwd;
				labels.push(name || firstPrompt || manifest.files[i].original);
			} finally { await handle.close(); }
		}
		await verify();
		const text: TrashSearchText = { search: cleanText(values.join(" ")), title: cleanText(labels.join(" / ")) };
		if (cwd !== undefined) text.cwd = cleanText(cwd) || undefined;
		await this.save(manifest.id, fingerprint, text, signal, verify);
		await verify();
		return text;
	}

	private async cached(id: string, fingerprint: string): Promise<TrashSearchText | undefined> {
		try {
			const path = join(this.directory, `${id}.json`), before = await fileStamp(path);
			const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const info = await handle.stat({ bigint: true });
				if (!info.isFile() || info.size > BigInt(CACHE_BYTES) || stamp(info) !== before) return;
				const buffer = Buffer.alloc(Number(info.size) + 1);
				let size = 0;
				while (size < buffer.length) {
					const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
					if (!bytesRead) break;
					size += bytesRead;
				}
				if (size !== Number(info.size) || stamp(await handle.stat({ bigint: true })) !== before || await fileStamp(path) !== before) return;
				const value = JSON.parse(buffer.subarray(0, size).toString("utf8"));
				if (value?.version !== VERSION || value.fingerprint !== fingerprint || typeof value.search !== "string" || typeof value.title !== "string" ||
					cleanText(value.search) !== value.search || cleanText(value.title) !== value.title ||
					(value.cwd !== undefined && (typeof value.cwd !== "string" || cleanText(value.cwd) !== value.cwd))) return;
				const text: TrashSearchText = { search: value.search, title: value.title };
				if (typeof value.cwd === "string") text.cwd = value.cwd;
				return text;
			} finally { await handle.close(); }
		} catch { return; } // Advisory only: unsafe, corrupt and unreadable entries are misses.
	}

	private async save(id: string, fingerprint: string, text: TrashSearchText, signal: AbortSignal, verify: () => Promise<void>) {
		const data = JSON.stringify({ version: VERSION, fingerprint, ...text });
		if (Buffer.byteLength(data) > CACHE_BYTES) return; // Never truncate display/search results.
		const path = join(this.directory, `${id}.json`), temp = join(this.directory, `${id}.${randomUUID()}.tmp`);
		let created = false;
		try {
			signal.throwIfAborted();
			await safeDirectory(this.directory);
			try { await regular(path); } catch (error) { if (!absent(error)) return; }
			const handle = await open(temp, "wx", 0o600);
			created = true;
			try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
			await verify();
			await regular(temp);
			try { await regular(path); } catch (error) { if (!absent(error)) return; }
			signal.throwIfAborted();
			await rename(temp, path);
		} catch { /* A read-only cache must not prevent fresh metadata display. */ }
		finally { if (created) { try { await regular(temp); await unlink(temp); } catch {} } }
	}

	async remove(ids: readonly string[]): Promise<void> {
		const selected = new Set(ids.filter(id => uuid.test(id)));
		if (!selected.size) return;
		let names: string[];
		try { await safePath(this.directory); names = await readdir(this.directory); }
		catch (error) { if (absent(error)) return; throw error; }
		let failure: unknown;
		for (const name of names) {
			const match = name.match(/^([0-9a-f-]{36})(?:\.json|\.([0-9a-f-]{36})\.tmp)$/);
			if (!match || !selected.has(match[1]) || (match[2] && !uuid.test(match[2]))) continue;
			const path = join(this.directory, name);
			try { await regular(path); await unlink(path); }
			catch (error) { if (!absent(error)) failure ??= error; }
		}
		// The adapter reports erasure failures after the completed session operation.
		// Include abandoned atomic-write files, which can also contain prompt text.
		if (failure) throw failure;
	}
}
