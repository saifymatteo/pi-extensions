import type { ProcessIdentity } from "./process-control";

/** Run only inside the new job console, before launching its actual command. */
export const windowsConsoleInputPrelude = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PiBgConsoleInput {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr attrs, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetStdHandle(int id, IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetConsoleProcessList([Out] uint[] list, uint size);
}
'@
# Detached launches can inherit an ignore-Ctrl+C attribute. Clear it in the job
# console BEFORE children start; registering a Node SIGINT listener alone cannot.
if (-not [PiBgConsoleInput]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)) {
    throw ('Cannot enable console Ctrl+C (Win32 ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + ')')
}
`;

/** Bash needs inheritable CONIN$, not PowerShell's native-command stdin pipe. */
export function windowsBashLaunchScript(commandPath: string): string {
	return windowsConsoleInputPrelude + `
$clients = New-Object System.UInt32[] 2
$count = [PiBgConsoleInput]::GetConsoleProcessList($clients, $clients.Length)
if ($count -ne 1 -or $clients[0] -ne $PID) { throw 'Job console is not isolated; refusing to attach input' }
$inputHandle = [PiBgConsoleInput]::CreateFile('CONIN$', [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($inputHandle -eq [IntPtr](-1)) { throw 'Cannot open job console input' }
try {
    if (-not [PiBgConsoleInput]::SetHandleInformation($inputHandle, 1, 1)) { throw 'Cannot inherit job console input' }
    if (-not [PiBgConsoleInput]::SetStdHandle(-10, $inputHandle)) { throw 'Cannot set job console input' }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $env:PI_BG_BASH_EXECUTABLE
    $start.Arguments = '-- "${commandPath.replace(/'/g, "''")}"'
    $start.UseShellExecute = $false
    # Avoid PowerShell's native-command pipeline, which replaces stdin with a
    # pipe and makes MSYS suppress native children's Ctrl+C handlers again.
    $child = [System.Diagnostics.Process]::Start($start)
    try { $child.WaitForExit(); $code = $child.ExitCode }
    finally { $child.Dispose() }
    exit $code
} finally { [void][PiBgConsoleInput]::CloseHandle($inputHandle) }
`;
}

/**
 * Run in a disposable powershell.exe, never in Pi's own console host.
 * Console enumeration/broadcast is not atomic: this is not hostile-process containment.
 */
export function windowsConsoleInterruptScript(root: ProcessIdentity, targets: ProcessIdentity[], ownerPid: number): string {
	// Callers validate the tree; also keep this serialization boundary non-executable.
	const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 1 && pid <= 0xffffffff;
	if (!validPid(ownerPid)) throw new Error("Unsafe console owner PID");
	const known = new Map<number, string>();
	for (const identity of [root, ...targets]) {
		if (!validPid(identity.pid) || identity.pid === ownerPid ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}0Z$/.test(identity.started) ||
			!Number.isFinite(Date.parse(identity.started))) {
			throw new Error("Invalid Windows console process identity");
		}
		const birth = identity.started.replace(/0Z$/, "Z");
		if (known.has(identity.pid) && known.get(identity.pid) !== birth) throw new Error("Conflicting console process identities");
		known.set(identity.pid, birth);
	}
	return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PiBgConsole {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetConsoleProcessList([Out] uint[] list, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint group);
}
'@
$known = @{ ${[...known].map(([pid, birth]) => `${pid} = '${birth}'`).join("; ")} }
$handles = @{}
$attached = $false
function Console-Error([string] $operation) {
    throw ($operation + ' failed (Win32 ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + ')')
}
function Get-ConsoleMembers {
    $capacity = 16
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $members = New-Object System.UInt32[] $capacity
        $count = [PiBgConsole]::GetConsoleProcessList($members, $members.Length)
        if ($count -eq 0) { Console-Error 'GetConsoleProcessList' }
        if ($count -gt 65536) { throw 'Console membership exceeds safety bound' }
        if ($count -le $members.Length) {
            $result = @($members[0..([int]$count - 1)])
            if (@($result | Select-Object -Unique).Count -ne $result.Count) { throw 'Invalid console membership' }
            return $result
        }
        $capacity = [int]$count
    }
    throw 'Console membership did not stabilize'
}
function Assert-Identity([int] $targetPid) {
    if (-not $known.ContainsKey($targetPid)) { throw ('Unauthenticated console process ' + $targetPid) }
    if (-not $handles.ContainsKey($targetPid)) {
        $p = [System.Diagnostics.Process]::GetProcessById($targetPid)
        # Store before accessing Handle so finally also disposes partial failures.
        $handles[$targetPid] = $p
        $null = $p.Handle
    }
    $p = $handles[$targetPid]
    $p.Refresh()
    if ($p.HasExited -or ($p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffff', [Globalization.CultureInfo]::InvariantCulture) + 'Z') -cne $known[$targetPid]) {
        throw ('Process birth identity changed or process exited: ' + $targetPid)
    }
}
function Assert-Members($members) {
    if ($members -contains ${ownerPid}) { throw 'Console contains Pi owner process' }
    if ($members -notcontains ${root.pid}) { throw 'Root absent from console' }
    if ($members -notcontains $PID) { throw 'Helper absent from attached console' }
    foreach ($member in $members) {
        if ($member -ne $PID) { Assert-Identity ([int]$member) }
    }
}
try {
    if ($known.ContainsKey([int]$PID)) { throw 'Helper PID conflicts with target' }
    Assert-Identity ${root.pid}
    foreach ($targetPid in @($known.Keys)) { Assert-Identity $targetPid }
    if (-not [PiBgConsole]::FreeConsole()) {
        # A pipe-only helper may start without any console.
        if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 6) { Console-Error 'FreeConsole' }
    }
    if (-not [PiBgConsole]::AttachConsole(${root.pid})) { Console-Error 'AttachConsole (root has no usable console)' }
    $attached = $true
    # AttachConsole resets the handler table: ignore Ctrl+C only AFTER attachment.
    if (-not [PiBgConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) { Console-Error 'SetConsoleCtrlHandler' }
    $members = @(Get-ConsoleMembers)
    Assert-Members $members
    $again = @(Get-ConsoleMembers)
    Assert-Members $again
    if ((($members | Sort-Object) -join ',') -cne (($again | Sort-Object) -join ',')) { throw 'Console membership changed during validation' }
    # Cached OS handles pin the authenticated process objects. Check births/liveness
    # again, then take the final membership snapshot immediately before broadcast.
    foreach ($targetPid in @($handles.Keys)) { Assert-Identity $targetPid }
    $last = @(Get-ConsoleMembers)
    if ((($again | Sort-Object) -join ',') -cne (($last | Sort-Object) -join ',')) { throw 'Console membership changed before Ctrl+C' }
    if (-not [PiBgConsole]::GenerateConsoleCtrlEvent(0, 0)) { Console-Error 'GenerateConsoleCtrlEvent' }
    # Delivery is asynchronous; do not tear down the sender immediately.
    Start-Sleep -Milliseconds 250
} catch {
    throw ('Graceful stop unsupported/error: ' + $_.Exception.Message)
} finally {
    if ($attached) { $null = [PiBgConsole]::FreeConsole() }
    foreach ($p in $handles.Values) { $p.Dispose() }
}
`;
}
