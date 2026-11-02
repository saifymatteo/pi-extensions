import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ProcessInfo = { pid: number; name: string; command: string };
const exec = promisify(execFile);

// Older Pi processes have no retention leases. Conservatively defer ALL maintenance
// while another CLI is running rather than pretending the current session is the only open one.
export function otherPiProcesses(processes: ProcessInfo[], ownPid: number): ProcessInfo[] {
	if (!processes.some((item) => item.pid === ownPid)) throw new Error("Cannot verify the current Pi process; cleanup deferred.");
	return processes.filter(({ pid, name, command }) => pid !== ownPid && (
		/^pi(?:-bolt)?(?:\.exe)?$/i.test(name) ||
		(/^(?:node|bun)(?:\.exe)?$/i.test(name) && /(?:[/\\]pi(?:-bolt)?(?:\.[cm]?js)?(?:[\s"']|$)|pi-coding-agent[/\\]|packages[/\\]coding-agent[/\\])/i.test(command))
	));
}

export async function processSnapshot(): Promise<ProcessInfo[]> {
	if (process.platform === "win32") {
		const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
			"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress"],
			{ timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
		const items = JSON.parse(stdout.replace(/^\uFEFF/, ""));
		if (!Array.isArray(items)) throw new Error("Cannot read process inventory; cleanup deferred.");
		return items.map((item) => ({ pid: item.ProcessId, name: item.Name ?? "", command: item.CommandLine ?? "" }));
	}
	const { stdout } = await exec("ps", ["-axo", "pid=,comm=,args="], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
	return stdout.split("\n").flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
		return match ? [{ pid: Number(match[1]), name: match[2].split("/").pop()!, command: match[3] }] : [];
	});
}

// A process scan starts PowerShell on Windows. Reuse a successful inventory for
// at most one second within ONE maintenance transaction, not once per file.
// This remains a sampled safeguard, not an OS lock honored by external SDK hosts.
export function maintenanceGuard(probe = ensureSinglePiProcess, clock = () => performance.now()) {
	let checkedUntil = -Infinity;
	return async () => {
		if (clock() >= checkedUntil) {
			await probe();
			checkedUntil = clock() + 1000;
		}
		return true;
	};
}

export async function ensureSinglePiProcess(): Promise<void> {
	const others = otherPiProcesses(await processSnapshot(), process.pid);
	if (others.length) throw new Error(`Session maintenance deferred: ${others.length} other Pi process(es) are open. Close them and retry /session-cleanup.`);
}
