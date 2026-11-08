import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { otherPiProcesses, processSnapshot, withLock, RetentionBusyError, type ProcessInfo } from "./safety.ts";

type RegistryOptions = { pid?: number; snapshot?: () => Promise<ProcessInfo[]>; clock?: () => number };
/** All instances sharing an agent home cooperate through this registry, outside session stores. */
export class SessionRegistry {
	readonly directory: string;
	private options: RegistryOptions;
	private identity?: Promise<string>;
	constructor(directory: string, options: RegistryOptions = {}) { this.directory = directory; this.options = options; }
	private get pid() { return this.options.pid ?? process.pid; }
	private async inventory() {
		const items = await (this.options.snapshot ?? processSnapshot)();
		// PID 0 is a valid OS pseudo-process (e.g. Windows System Idle Process), not an invalid inventory entry.
		if (items.some(item => !Number.isInteger(item.pid) || item.pid < 0) || new Set(items.map(item => item.pid)).size !== items.length) throw new Error("Invalid process inventory; cleanup deferred.");
		// Also verifies that the inventory includes this process.
		const peers = otherPiProcesses(items, this.pid);
		return [items.find(item => item.pid === this.pid)!, ...peers];
	}
	private started() {
		return this.identity ??= this.inventory().then(items => {
			const started = items[0].started;
			if (typeof started !== "string" || !started) throw new Error("Cannot verify Pi process start time; cleanup deferred.");
			return started;
		}).catch(error => { this.identity = undefined; throw error; });
	}
	async register(paths: readonly string[], signal?: AbortSignal) {
		if (paths.some(path => !isAbsolute(path))) throw new Error("Session registration requires absolute paths.");
		const started = await this.started();
		const publish = async () => {
			const target = join(this.directory, `${this.pid}.json`);
			try {
				const info = await lstat(target);
				if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe session registration.");
			} catch (error: any) { if (error.code !== "ENOENT") throw error; }
			const temp = join(this.directory, `${this.pid}-${randomUUID()}.tmp`);
			const file = await open(temp, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify({ version: 1, pid: this.pid, started, paths: [...new Set(paths.map(path => resolve(path)))] }));
				await file.sync();
				await file.close();
				await rename(temp, target);
			} finally { await file.close(); await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
		};
		for (;;) {
			signal?.throwIfAborted();
			try { return await withLock(this.directory, publish, ".registry.lock"); }
			catch (error) {
				// Startup retries contention in the background; session changes and explicit
				// maintenance fail immediately instead of waiting behind an approval dialog.
				if (!signal || !(error instanceof RetentionBusyError)) throw error;
				await delay(100, undefined, { signal });
			}
		}
	}
	private async activePaths(): Promise<string[]> {
		const paths: string[] = [];
		for (const item of await this.inventory()) {
			try {
				if (typeof item.started !== "string" || !item.started) throw new Error("Missing process start time");
				const path = join(this.directory, `${item.pid}.json`);
				const before = await lstat(path);
				if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024) throw new Error("Unsafe session registration");
				const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				try {
					const info = await file.stat();
					if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size > 64 * 1024) throw new Error("Changed session registration");
					const record = JSON.parse(await file.readFile("utf8"));
					if (record.version !== 1 || record.pid !== item.pid || record.started !== item.started || !Array.isArray(record.paths) || record.paths.some((p: unknown) => typeof p !== "string" || !isAbsolute(p))) throw new Error("Invalid or stale session registration");
					paths.push(...record.paths);
				} finally { await file.close(); }
			} catch {
				throw new Error(`Session maintenance deferred: Pi process ${item.pid} has no verifiable session registration. Reload/update that instance, or close it and retry /session-cleanup. Instances using another agent home must be closed.`);
			}
		}
		return paths;
	}
	async maintain<T>(work: (activePaths: () => Promise<string[]>) => Promise<T>): Promise<T> {
		return withLock(this.directory, async () => {
			// The gate freezes registrations/switch intents throughout discovery and mutation.
			// Cache successful OS inventories for at most one second to detect newcomers.
			let checkedUntil = -Infinity;
			let paths: string[] = [];
			const clock = this.options.clock ?? (() => performance.now());
			return work(async () => {
				if (clock() >= checkedUntil) {
					paths = await this.activePaths();
					checkedUntil = clock() + 1000;
				}
				return paths;
			});
		}, ".registry.lock");
	}
}
