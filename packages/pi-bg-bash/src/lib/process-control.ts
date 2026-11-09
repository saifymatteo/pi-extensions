import { execFile } from "node:child_process";
import process from "node:process";
import { windowsConsoleInterruptScript } from "./windows-console";

export type StopMode = "graceful" | "force";

export interface ProcessIdentity {
	pid: number;
	/** OS birth identifier, not a capture timestamp. Windows callers must supply a native PID. */
	started: string;
}

interface ProcessRow extends ProcessIdentity {
	ppid: number;
	dead?: boolean;
}

const WINDOWS = process.platform === "win32";
const GRACE_MS = 3_000;
// Retain authenticated descendants after a partial failure so retry cannot forget
// survivors just because their launcher exited during the previous stop.
const pendingTrees = new WeakMap<ProcessIdentity, Map<number, ProcessRow>>();

function validatePid(pid: number): void {
	if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
		throw new Error(`Unsafe process PID: ${pid}`);
	}
}

function validateIdentity(identity: ProcessIdentity): void {
	validatePid(identity.pid);
	if (typeof identity.started !== "string" || !identity.started || !Number.isFinite(Date.parse(identity.started))) {
		throw new Error("Missing or invalid process birth identity");
	}
}

function run(file: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, {
			encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, signal, // Win32_Process scans can take 20s+ under load
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
		}, (error, stdout, stderr) => {
			if (error) reject(error);
			else if (stderr.trim()) reject(new Error(`Process command reported: ${stderr.trim()}`));
			else resolve(stdout);
		});
	});
}

function powershell(script: string, signal?: AbortSignal): Promise<string> {
	return run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
		`$ErrorActionPreference='Stop'; ${script}`], signal);
}

async function processTable(signal?: AbortSignal): Promise<Map<number, ProcessRow>> {
	let rows: ProcessRow[];
	if (WINDOWS) {
		const output = await powershell(`$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop | ForEach-Object {
			@{pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId;
			started=$(if ($null -ne $_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {''})}
		}); ConvertTo-Json -Compress -InputObject $rows`, signal);
		const parsed: unknown = JSON.parse(output);
		if (!Array.isArray(parsed)) throw new Error("Invalid CIM process table");
		rows = parsed;
	} else {
		const output = await run("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "stat="], signal);
		rows = output.split(/\r?\n/).filter(line => line.trim()).map(line => {
			const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s*$/.exec(line);
			if (!match) throw new Error("Invalid ps process table row");
			return { pid: Number(match[1]), ppid: Number(match[2]), started: match[3].replace(/\s+/g, " ") + " UTC",
				dead: /^[ZX]/.test(match[4]) };
		});
	}
	const table = new Map<number, ProcessRow>();
	for (const row of rows) {
		if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.ppid) || row.ppid < 0 ||
			typeof row.started !== "string" || (row.started && !Number.isFinite(Date.parse(row.started))) || table.has(row.pid)) {
			throw new Error("Invalid process table");
		}
		table.set(row.pid, row);
	}
	// A successful but empty/filtered listing cannot establish absence safely.
	if (!table.has(process.pid)) throw new Error("Incomplete process table (self missing)");
	return table;
}

function matching(table: Map<number, ProcessRow>, identity: ProcessIdentity): ProcessRow | undefined {
	const row = table.get(identity.pid);
	return row?.started === identity.started && !row.dead ? row : undefined;
}

/** Snapshot descendants only through verified, live ancestors. Never follow a reused parent PID. */
function descendants(table: Map<number, ProcessRow>, roots: ProcessIdentity[]): ProcessRow[] {
	const found = new Map<number, ProcessRow>();
	const queue = roots.map(root => matching(table, root)).filter((row): row is ProcessRow => !!row);
	for (const root of queue) found.set(root.pid, root);
	for (let i = 0; i < queue.length; i++) {
		const parent = queue[i];
		for (const child of table.values()) {
			if (child.ppid !== parent.pid || child.pid === parent.pid || child.dead) continue;
			validateIdentity(child);
			// Windows retains the numeric parent PID after exit; it may now belong to a newer process.
			if (Date.parse(child.started) < Date.parse(parent.started)) continue;
			if (!found.has(child.pid)) {
				found.set(child.pid, child);
				queue.push(child);
			}
		}
	}
	return [...found.values()];
}

/** An exited/reused parent cannot authenticate newly observed children. Do not adopt them. */
function uncertainChildren(table: Map<number, ProcessRow>, targets: Map<number, ProcessRow>): boolean {
	return [...table.values()].some(row => {
		const parent = targets.get(row.ppid);
		return parent && !row.dead && !matching(table, parent) &&
			targets.get(row.pid)?.started !== row.started &&
			(!row.started || Date.parse(row.started) >= Date.parse(parent.started));
	});
}

/** Snapshot ownership evidence only; this cheap query does not establish liveness. */
export function hasTrackedDescendants(identity: ProcessIdentity): boolean {
	return (pendingTrees.get(identity)?.size ?? 0) > 1;
}

/** Capture a real OS PID and known descendants. Does not translate MSYS PIDs. */
export async function captureProcess(pid: number, signal?: AbortSignal): Promise<ProcessIdentity> {
	validatePid(pid);
	const table = await processTable(signal);
	const row = table.get(pid);
	if (!row || row.dead) throw new Error(`Process ${pid} is gone`);
	validateIdentity(row);
	const identity = { pid: row.pid, started: row.started };
	// Remember already-owned descendants at launch, not only at the first stop.
	// A launcher exiting later must not make these children undiscoverable.
	pendingTrees.set(identity, new Map(descendants(table, [identity]).map(child => [child.pid, child])));
	return identity;
}

function windowsKillScript(identity: ProcessIdentity): string {
	// CIM records microseconds; .NET also exposes a seventh, 100ns digit.
	const birth = identity.started.replace(/(\.\d{6})\dZ$/, "$1Z").replace(/'/g, "''");
	return `$p = $null;
		try { $p = [System.Diagnostics.Process]::GetProcessById(${identity.pid}) }
		catch {
			if ($_.Exception -isnot [System.ArgumentException] -and
				$_.Exception.InnerException -isnot [System.ArgumentException]) { throw }
		}
		if ($null -ne $p) {
			try {
				# Cache the OS handle before checking birth; act on that same process object.
				$null = $p.Handle;
				if (($p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffff') + 'Z') -ceq '${birth}') {
					$p.Kill()
				}
			} finally { $p.Dispose() }
		}`;
}

async function signalAll(targets: ProcessIdentity[], mode: StopMode): Promise<void> {
	for (const identity of targets) validateIdentity(identity);
	if (WINDOWS) {
		// One interpreter, not one per descendant. Every kill validates the birth
		// identity against an open OS handle; console interruption is separate.
		if (targets.length) await powershell(targets.map(windowsKillScript).join("\n"));
		return;
	}
	for (const identity of targets) {
		// ps + kill is not atomic; keep the check immediately adjacent to each signal.
		if (!matching(await processTable(), identity)) continue;
		try { process.kill(identity.pid, mode === "force" ? "SIGKILL" : "SIGINT"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	}
}

/**
 * Stop the snapshotted tree without automatic escalation. Graceful means SIGINT
 * on Unix or a safely isolated console Ctrl+C on Windows; force skips grace.
 * 'gone' means the root was already absent/reused before
 * any action; 'stopped' means all tracked identities are gone; 'stuck' means a
 * survivor or newly observed descendant remains. Enumeration/permission errors
 * reject, never masquerade as absence. No names, ports, groups, or PID 0 used.
 *
 * This is best-effort process control, not containment: children that fork and
 * reparent between snapshots cannot be recovered safely. Unix ps birth times
 * have one-second precision, and portable PID signaling has an unavoidable
 * check/signal race. Stronger guarantees require OS job objects/pidfds.
 */
export async function stopProcessTree(identity: ProcessIdentity, mode: StopMode = "force"): Promise<"stopped" | "gone" | "stuck"> {
	validateIdentity(identity);
	if (mode !== "graceful" && mode !== "force") throw new Error("Invalid process stop mode");
	let table = await processTable();
	const previous = pendingTrees.get(identity);
	if (!matching(table, identity) && !previous) return "gone";
	const targets = previous ?? new Map<number, ProcessRow>();
	for (const row of descendants(table, [identity, ...targets.values()])) targets.set(row.pid, row);
	// Validate the entire snapshot before taking any destructive action.
	for (const target of targets.values()) validateIdentity(target);
	pendingTrees.set(identity, targets);
	const live = [...targets.values()].filter(target => matching(table, target));
	if (!live.length && !uncertainChildren(table, targets)) {
		pendingTrees.delete(identity);
		return "gone";
	}
	if (WINDOWS && mode === "graceful") {
		// A console event reaches its console, not a PID. The helper authenticates
		// every attached process and rejects shared/unknown consoles before sending.
		if (live.length) await powershell(windowsConsoleInterruptScript(live[0], live, process.pid));
	} else await signalAll(live.reverse(), mode);
	// Graceful stopping never kills survivors. Force only waits for OS retirement.
	await new Promise(resolve => setTimeout(resolve, mode === "graceful" ? GRACE_MS : 100));
	table = await processTable();
	const uncertain = uncertainChildren(table, targets);
	const survivors = descendants(table, [...targets.values()]);
	for (const child of survivors) targets.set(child.pid, child);
	if (uncertain || survivors.length) return "stuck";
	pendingTrees.delete(identity);
	return "stopped";
}
