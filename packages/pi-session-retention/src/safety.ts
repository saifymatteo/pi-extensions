import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, parse, relative, resolve } from "node:path";

export type ProcessInfo = { pid: number; name: string; command: string; started?: string };
const exec = promisify(execFile);

// Processes without a verified session registration still require a fail-closed fallback.
// Node-hosted recognition requires a pi script FILE (pi.js/.cjs/.mjs): a bare "pi"/"pi-bolt"
// path token also matches unrelated tooling, e.g. hindsight's `deepen.js --repo D:\Git\Pi-Bolt`.
export function otherPiProcesses(processes: ProcessInfo[], ownPid: number): ProcessInfo[] {
	if (!processes.some((item) => item.pid === ownPid)) throw new Error("Cannot verify the current Pi process; cleanup deferred.");
	return processes.filter(({ pid, name, command }) => pid !== ownPid && (
		/^pi(?:-bolt)?(?:\.exe)?$/i.test(name) ||
		(/^(?:node|bun)(?:\.exe)?$/i.test(name) && /(?:[/\\]pi(?:-bolt)?\.[cm]?js(?:[\s"']|$)|pi-coding-agent[/\\]|packages[/\\]coding-agent[/\\])/i.test(command))
	));
}

export async function processSnapshot(): Promise<ProcessInfo[]> {
	if (process.platform === "win32") {
		const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
			"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,Name,CommandLine,@{Name='Started';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().Ticks.ToString()}}}) | ConvertTo-Json -Compress"],
			{ timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }); // Win32_Process enumeration can take 20s+ under load; 15s killed every scan on such machines
		const items = JSON.parse(stdout.replace(/^\uFEFF/, ""));
		if (!Array.isArray(items)) throw new Error("Cannot read process inventory; cleanup deferred.");
		return items.map((item) => ({ pid: item.ProcessId, name: item.Name ?? "", command: item.CommandLine ?? "", started: item.Started }));
	}
	const { stdout } = await exec("ps", ["-axo", "pid=,lstart=,comm=,args="], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
	return stdout.split("\n").flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+((?:\S+\s+){4}\S+)\s+(\S+)\s+(.*)$/);
		return match ? [{ pid: Number(match[1]), started: match[2].replace(/\s+/g, " "), name: match[3].split("/").pop()!, command: match[4] }] : [];
	});
}

// A process scan starts PowerShell on Windows. Reuse a successful inventory for
// at most one second within ONE maintenance transaction, not once per file.
// This remains a sampled safeguard, not an OS lock honored by external SDK hosts.
export function maintenanceGuard(probe: () => Promise<void>, clock = () => performance.now()) {
	let checkedUntil = -Infinity;
	return async () => {
		if (clock() >= checkedUntil) {
			await probe();
			checkedUntil = clock() + 1000;
		}
		return true;
	};
}

export async function safeDirectory(path: string): Promise<void> {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of relative(current, absolute).split(/[/\\]/).filter(Boolean)) {
		current = join(current, part);
		try { await mkdir(current); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
		const info = await lstat(current);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe retention directory: ${current}`);
	}
}

export class RetentionBusyError extends Error {}

// Shared by store maintenance and the short registration/session-change critical section.
// Stale or unverifiable owners are deliberately never guessed away.
export async function withLock<T>(directory: string, work: () => Promise<T>, name = ".maintenance.lock"): Promise<T> {
	await safeDirectory(directory);
	const path = join(directory, name);
	// Publish a fully written owner record exclusively. Creating the lock path
	// before writing JSON exposes an empty/partial owner to concurrent startups.
	const temp = join(directory, `.lock-${randomUUID()}.tmp`);
	const file = await open(temp, "wx", 0o600);
	try {
		await file.writeFile(JSON.stringify({ pid: process.pid }));
		await file.sync();
		const created = await file.stat();
		try { await link(temp, path); }
		catch (error: any) {
			if (error.code !== "EEXIST") throw error;
			let owner;
			try {
				const info = await lstat(path);
				if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe retention lock.");
				owner = JSON.parse(await readFile(path, "utf8"));
			} catch (readError: any) {
				// The previous owner can release the lock between link() and inspection.
				if (readError.code === "ENOENT") throw new RetentionBusyError("Session maintenance just finished; retry.");
				throw readError;
			}
			if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid retention lock; cleanup deferred.");
			try { process.kill(owner.pid, 0); }
			catch (probe: any) {
				if (probe.code !== "ESRCH") throw new Error("Cannot verify retention lock owner; cleanup deferred.");
				throw new Error(`Stale session-maintenance lock: ${path}. Close other Pi processes before removing this lock and retrying.`);
			}
			throw new RetentionBusyError("Session maintenance or registration is already running. Retry after it finishes.");
		}
		try {
			await unlink(temp);
			return await work();
		} finally {
			const current = await lstat(path);
			if (!current.isFile() || current.isSymbolicLink() || current.ino !== created.ino || current.dev !== created.dev) throw new Error(`Retention lock changed; left untouched: ${path}`);
			await unlink(path);
		}
	} finally {
		try { await file.close(); } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
	}
}
