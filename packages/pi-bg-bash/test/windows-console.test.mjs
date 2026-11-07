import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtension } from '../../../test/load-extension.mjs';

const { windowsConsoleInterruptScript, windowsConsoleInputPrelude, windowsBashLaunchScript } = loadExtension(new URL('../src/lib/windows-console.ts', import.meta.url));
const root = { pid: 100, started: '2026-01-05T12:00:00.1234560Z' };
const child = { pid: 101, started: '2026-01-05T12:00:01.6543210Z' };
const script = () => windowsConsoleInterruptScript(root, [root, child], 900);
const exec = promisify(execFile);
const windows = process.platform === 'win32';
async function ps(source) {
  return exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(source, 'utf16le').toString('base64')], { timeout: 25_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
}

test('serializes only authenticated numeric PIDs and CIM UTC birth identities', () => {
  assert.match(script(), /100 = '2026-01-05T12:00:00\.123456Z'/);
  for (const bad of [0, 1, -1, NaN, Infinity, 1.5, '100', 900]) {
    assert.throws(() => windowsConsoleInterruptScript({ ...root, pid: bad }, [], 900), /identity/);
  }
  for (const started of ['', "'; Stop-Process -Id 900; '", '2026-01-05T12:00:00.1234567Z', '2026-01-05T12:00:00Z']) {
    assert.throws(() => windowsConsoleInterruptScript({ ...root, started }, [], 900), /identity/);
  }
  assert.throws(() => windowsConsoleInterruptScript(root, [{ ...root, started: child.started }], 900), /Conflicting/);
  assert.throws(() => windowsConsoleInterruptScript(root, [], 0), /owner/);
  assert.doesNotMatch(script(), /CloseMainWindow|\.Kill\(|Stop-Process|process\.kill/);
  assert.match(script(), /GenerateConsoleCtrlEvent\(0, 0\)/);
  assert.ok(script().indexOf('::AttachConsole(100)') < script().indexOf('::SetConsoleCtrlHandler([IntPtr]::Zero'));
});

test('Bash bootstrap authenticates its solo console, inherits CONIN$, and avoids native stdin piping', () => {
  const source = windowsBashLaunchScript("C:/fixture/O'Brien preview.sh");
  assert.match(source, /\$start.Arguments = '-- "C:\/fixture\/O''Brien preview.sh"'/);
  assert.ok(source.indexOf('GetConsoleProcessList') < source.indexOf('::CreateFile('));
  assert.ok(source.indexOf('::SetHandleInformation($inputHandle, 1, 1)') < source.indexOf('[System.Diagnostics.Process]::Start'));
  assert.match(source, /finally \{ \[void\]\[PiBgConsoleInput\]::CloseHandle\(\$inputHandle\) \}/);
});

for (const [name, count, member] of [['shared', 2, '(uint)System.Diagnostics.Process.GetCurrentProcess().Id'],
  ['missing', 0, '0'], ['foreign', 1, '1']]) {
  test(`Bash bootstrap refuses ${name} console before touching input`, { skip: !windows }, async () => {
    const fake = `Add-Type -TypeDefinition @'
using System;
public static class PiBgConsoleInput {
 public static bool SetConsoleCtrlHandler(IntPtr handler, bool add) { return true; }
 public static uint GetConsoleProcessList(uint[] buffer, uint size) { buffer[0] = ${member}; return ${count}; }
}
'@`;
    const source = windowsBashLaunchScript('unused.sh').replace(/Add-Type -TypeDefinition @'[\s\S]*?\r?\n'@/, fake);
    await assert.rejects(ps(source), error => /Job console is not isolated/.test(error.stderr));
  });
}

test('bootstrap clears inherited Ctrl+C suppression before commands; all scripts parse in PowerShell 5.1', { skip: !windows }, async () => {
  assert.match(windowsConsoleInputPrelude, /SetConsoleCtrlHandler\(\[IntPtr\]::Zero, \$false\)/);
  const encoded = Buffer.from(windowsBashLaunchScript("C:/fixture/O'Brien preview.sh") + '\n' + script(), 'utf8').toString('base64');
  const { stdout } = await ps(`$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$tokens = $null; $errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
'parsed ' + $PSVersionTable.PSVersion.ToString()`);
  assert.match(stdout, /parsed 5\.1\./);
});

// Exercise the actual PowerShell control flow, substituting only OS boundaries.
// No fixture ever attaches to a console or delivers a real control event.
async function fixture({ lists = ['100,101,SELF'], fail = '', changed = 0, missing = 0, changeOnRefresh = 0 } = {}) {
  const arrays = lists.map(list => `new uint[] { ${list.replaceAll('SELF', '(uint)System.Diagnostics.Process.GetCurrentProcess().Id')} }`).join(', ');
  const native = `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class PiBgConsole {
 public static List<string> Calls = new List<string>();
 public static int reads;
 public static uint[][] lists = new uint[][] { ${arrays} };
 public static bool FreeConsole() { Calls.Add("free"); return true; }
 public static bool AttachConsole(uint p) { Calls.Add("attach"); return ${fail === 'attach' ? 'false' : 'true'}; }
 public static bool SetConsoleCtrlHandler(IntPtr h, bool add) { Calls.Add("handler"); return ${fail === 'handler' ? 'false' : 'true'}; }
 public static uint GetConsoleProcessList(uint[] buffer, uint size) {
  Calls.Add("list");
  ${fail === 'list' ? 'return 0;' : fail === 'oversize' ? 'return 65537;' : fail === 'unstable' ? 'return size + 1;' : `var list = lists[Math.Min(reads++, lists.Length - 1)]; Array.Copy(list, buffer, Math.Min(list.Length, buffer.Length)); return (uint)list.Length;`}
 }
 public static bool GenerateConsoleCtrlEvent(uint e, uint g) { Calls.Add("signal:" + e + ":" + g); return ${fail === 'signal' ? 'false' : 'true'}; }
}
'@`;
  const source = script().replace(/Add-Type -TypeDefinition @'[\s\S]*?\r?\n'@/, native)
    .replace('[System.Diagnostics.Process]::GetProcessById($targetPid)', '(Get-FixtureProcess $targetPid)');
  const { stdout } = await ps(`$ErrorActionPreference = 'Stop'
$script:opened = @(); $script:disposed = @(); $script:refreshes = @{}
function Get-FixtureProcess([int]$id) {
 if ($id -eq ${missing}) { throw 'process access denied or missing' }
 $script:opened += $id
 $birth = if ($id -eq 100) { '${root.started}' } else { '${child.started}' }
 if ($id -eq ${changed}) { $birth = '2026-01-05T12:00:02.0000000Z' }
 $p = [pscustomobject]@{ Id=$id; Handle=123; HasExited=$false; StartTime=[DateTime]::Parse($birth).ToUniversalTime() }
 $p | Add-Member ScriptMethod Refresh {
  $script:refreshes[$this.Id]++
  if ($this.Id -eq ${changeOnRefresh} -and $script:refreshes[$this.Id] -ge 3) { $this.HasExited=$true }
 }
 $p | Add-Member ScriptMethod Dispose { $script:disposed += $this.Id }
 return $p
}
$message = ''
try { & {
${source}
} } catch { $message = $_.Exception.Message }
$calls = @(); try { $calls = @([PiBgConsole]::Calls) } catch {}
[pscustomobject]@{message=$message; calls=$calls; opened=@($script:opened); disposed=@($script:disposed)} | ConvertTo-Json -Compress`);
  return JSON.parse(stdout.trim());
}

test('isolated authenticated console: one real Ctrl+C API call, held handles, cleanup', { skip: !windows }, async () => {
  const result = await fixture();
  assert.equal(result.message, '');
  assert.deepEqual(result.calls, ['free', 'attach', 'handler', 'list', 'list', 'list', 'signal:0:0', 'free']);
  assert.deepEqual(result.opened, [100, 101]);
  assert.deepEqual(result.disposed.sort(), [100, 101]);
});

for (const [name, options, error] of [
  ['Pi shared console', { lists: ['100,900,SELF'] }, /owner/],
  ['unrelated sentinel', { lists: ['100,500,SELF'] }, /Unauthenticated/],
  ['root absent', { lists: ['101,SELF'] }, /Root absent/],
  ['helper absent', { lists: ['100,101'] }, /Helper absent/],
  ['reused root', { changed: 100 }, /birth identity/],
  ['reused child', { changed: 101 }, /birth identity/],
  ['process access error', { missing: 101 }, /access denied/],
  ['late process exit', { changeOnRefresh: 101 }, /process exited/],
  ['late unrelated member', { lists: ['100,101,SELF', '100,101,SELF', '100,101,500,SELF'] }, /membership changed/],
  ['membership shrink', { lists: ['100,101,SELF', '100,SELF'] }, /membership changed/],
  ['duplicate membership', { lists: ['100,100,SELF'] }, /Invalid console membership/],
  ['missing console', { fail: 'attach' }, /AttachConsole/],
  ['handler error', { fail: 'handler' }, /SetConsoleCtrlHandler/],
  ['enumeration error', { fail: 'list' }, /GetConsoleProcessList/],
]) {
  test(`fails closed: ${name}`, { skip: !windows }, async () => {
    const result = await fixture(options);
    assert.match(result.message, /Graceful stop unsupported\/error:/);
    assert.match(result.message, error);
    assert.ok(!result.calls.some(call => call.startsWith('signal:')));
    assert.deepEqual(result.disposed.sort(), result.opened.sort());
    if (result.calls.includes('handler')) assert.equal(result.calls.at(-1), 'free');
  });
}

test('bounded console enumeration resizing rejects unstable oversized snapshots', { skip: !windows }, async () => {
  const large = Array.from({ length: 17 }, (_, i) => i + 100).join(',') + ',SELF';
  const result = await fixture({ lists: [large, '100,101,SELF'] });
  assert.equal(result.message, '');
  assert.equal(result.calls.filter(c => c === 'list').length, 4);
  const tooLarge = await fixture({ fail: 'oversize' });
  assert.match(tooLarge.message, /safety bound/);
  assert.ok(!tooLarge.calls.some(c => c.startsWith('signal:')));
  const unstable = await fixture({ fail: 'unstable' });
  assert.match(unstable.message, /did not stabilize/);
  assert.equal(unstable.calls.filter(c => c === 'list').length, 4);
  assert.ok(!unstable.calls.some(c => c.startsWith('signal:')));
});

test('signal API failure is reported and still releases the console and handles', { skip: !windows }, async () => {
  const result = await fixture({ fail: 'signal' });
  assert.match(result.message, /GenerateConsoleCtrlEvent/);
  assert.equal(result.calls.at(-1), 'free');
  assert.deepEqual(result.disposed.sort(), [100, 101]);
});

// Opt in: only two test-owned hidden consoles. Both Node fixtures self-expire;
// no kill calls, no attachment to the test runner/Pi console, even on failure.
test('native isolated-console Ctrl+C runs a Node SIGINT handler and preserves sentinel', {
  skip: !windows || process.env.PI_BG_CONSOLE_NATIVE_TEST !== '1', timeout: 65_000,
}, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-bg-console-'));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  try {
    const nodeFile = join(folder, 'fixture.cjs');
    await writeFile(nodeFile, `const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[2];
const dir = __dirname;
process.on('SIGINT', () => { fs.writeFileSync(path.join(dir, mode + '.interrupt'), 'SIGINT'); if (mode === 'root') process.exit(0); });
fs.writeFileSync(path.join(dir, mode + '.ready'), String(process.pid));
setTimeout(() => { fs.writeFileSync(path.join(dir, mode + '.expired'), 'expired'); }, 30000);
`);
    const jobFile = join(folder, 'job.ps1');
    await writeFile(jobFile, windowsConsoleInputPrelude + `\n& ${quote(process.execPath)} ${quote(nodeFile)} root\n`);
    const launcher = join(folder, 'launch.ps1');
    await writeFile(launcher, `$ErrorActionPreference='Stop'
$root = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '"${jobFile}"') -WindowStyle Hidden -RedirectStandardOutput ${quote(join(folder, 'root.out'))} -RedirectStandardError ${quote(join(folder, 'root.err'))} -PassThru
$sentinel = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList @('"${nodeFile}"', 'sentinel') -WindowStyle Hidden -RedirectStandardOutput ${quote(join(folder, 'sentinel.out'))} -RedirectStandardError ${quote(join(folder, 'sentinel.err'))} -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (-not ((Test-Path ${quote(join(folder, 'root.ready'))}) -and (Test-Path ${quote(join(folder, 'sentinel.ready'))}))) {
 if ([DateTime]::UtcNow -gt $deadline) { throw 'Fixture readiness timeout' }
 Start-Sleep -Milliseconds 20
}
$nodePid = [int](Get-Content ${quote(join(folder, 'root.ready'))})
$rows = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $root.Id + ' OR ProcessId = ' + $nodePid))
$row = $rows | Where-Object ProcessId -eq $root.Id
$nodeRow = $rows | Where-Object ProcessId -eq $nodePid
@{pid=$root.Id; started=$row.CreationDate.ToUniversalTime().ToString('o'); sentinel=$sentinel.Id;
 targets=@(@{pid=$root.Id; started=$row.CreationDate.ToUniversalTime().ToString('o')},
 @{pid=$nodePid; started=$nodeRow.CreationDate.ToUniversalTime().ToString('o')})} | ConvertTo-Json -Compress -Depth 3
`);
    const launch = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher], { timeout: 25_000, windowsHide: true });
    const identity = JSON.parse(launch.stdout.trim());
    const delivered = await ps(windowsConsoleInterruptScript(identity, identity.targets, process.pid));
    assert.equal(delivered.stderr, '');
    // API acceptance is insufficient: require evidence from the application's handler.
    assert.equal(await readFile(join(folder, 'root.interrupt'), 'utf8'), 'SIGINT');
    await assert.rejects(readFile(join(folder, 'sentinel.interrupt')), { code: 'ENOENT' });
    console.log(`native Ctrl+C handler confirmed: launcher ${identity.pid}, Node ${identity.targets[1].pid}; unrelated sentinel ${identity.sentinel} untouched`);
  } finally {
    // Every fixture naturally expires after 30s. Keep its files available until then.
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 31'], { timeout: 35_000, windowsHide: true });
    await rm(folder, { recursive: true, force: true });
  }
});
