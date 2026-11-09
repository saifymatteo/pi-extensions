import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension } from '../../../test/load-extension.mjs';

const file = new URL('../src/lib/process-control.ts', import.meta.url);
const birth = 'Mon Jan 5 12:00:00 2026 UTC';
const later = 'Mon Jan 5 12:00:01 2026 UTC';
const winBirth = '2026-01-05T12:00:00.0000000Z';
const winLater = '2026-01-05T12:00:01.0000000Z';

function fixture({ windows = false, onRead, onSignal, onWait, output, commandError, consoleError } = {}) {
  const started = windows ? winBirth : birth;
  const rows = new Map([
    [900, { pid: 900, ppid: 1, started }], // fake harness
    [100, { pid: 100, ppid: 1, started }],
    [101, { pid: 101, ppid: 100, started }],
    [102, { pid: 102, ppid: 101, started }],
    [500, { pid: 500, ppid: 1, started }], // unrelated
  ]);
  const calls = [], signals = [], waits = [];
  let reads = 0;
  const emitSignal = (pid, signal) => {
    signals.push([pid, signal]);
    if (onSignal) onSignal({ pid, signal, force: signal === 'SIGKILL', rows });
    else if (signal === 'SIGKILL') rows.delete(pid);
  };
  const fakeProcess = {
    platform: windows ? 'win32' : 'linux', pid: 900, env: {},
    kill(pid, signal) {
      assert.equal(windows, false, 'Windows must not emulate graceful signals with process.kill');
      assert.ok(pid > 1 && pid !== 900);
      emitSignal(pid, signal);
    },
  };
  const api = loadExtension(file, {
    'node:process': fakeProcess,
    './windows-console': { windowsConsoleInterruptScript: (root, targets, ownerPid) =>
      '# PI_BG_CONSOLE\n' + JSON.stringify({ root, targets, ownerPid }) },
    'node:child_process': {
      execFile(command, args, options, callback) {
        calls.push({ command, args, options });
        try {
          if (commandError) throw commandError;
          const script = args.at(-1);
          if (windows && script.includes('# PI_BG_CONSOLE')) {
            if (consoleError) throw consoleError;
            const { targets, ownerPid } = JSON.parse(script.split('# PI_BG_CONSOLE\n')[1]);
            assert.equal(ownerPid, 900);
            for (const target of targets.reverse()) {
              if (rows.get(target.pid)?.started === target.started) emitSignal(target.pid, 'SIGINT');
            }
            callback(null, '', '');
            return;
          }
          if (windows && script.includes('-ceq')) {
            for (const match of script.matchAll(/GetProcessById\((\d+)\)[\s\S]*?-ceq '([^']+)'/g)) {
              const pid = Number(match[1]);
              if (rows.get(pid)?.started.replace(/(\.\d{6})\dZ$/, '$1Z') === match[2]) emitSignal(pid, 'SIGKILL');
            }
            callback(null, '', '');
            return;
          }
          reads++;
          onRead?.({ reads, rows });
          const text = output ?? (windows ? JSON.stringify([...rows.values()]) : [...rows.values()].map(row =>
            `${row.pid} ${row.ppid} ${row.started.replace(/ UTC$/, '')} ${row.dead ? 'Z' : 'S'}`).join('\n'));
          callback(null, text, '');
        } catch (error) { callback(error, '', ''); }
      },
    },
  }, {
    process: fakeProcess,
    setTimeout(callback, ms) {
      waits.push(ms);
      onWait?.({ ms, rows });
      queueMicrotask(callback);
      return waits.length;
    },
  });
  return { ...api, rows, calls, signals, waits, identity: { pid: 100, started } };
}

for (const windows of [false, true]) {
  const platform = windows ? 'Windows' : 'Unix';
  test(`${platform}: captures birth identity; validates PID, identity and mode before OS calls`, async () => {
    const f = fixture({ windows });
    for (const pid of [0, 1, -10, 900, 1.5, NaN, Infinity, '100']) {
      await assert.rejects(f.captureProcess(pid), /Unsafe/);
      await assert.rejects(f.stopProcessTree({ pid, started: birth }), /Unsafe/);
    }
    await assert.rejects(f.stopProcessTree({ pid: 100, started: '' }), /identity/);
    await assert.rejects(f.stopProcessTree(f.identity, 'auto'), /mode/);
    assert.equal(f.calls.length, 0);
    const controller = new AbortController();
    assert.deepEqual({ ...await f.captureProcess(100, controller.signal) }, f.identity);
    assert.equal(f.calls[0].options.signal, controller.signal);
    await assert.rejects(f.captureProcess(333), /gone/);
    assert.equal(f.signals.length, 0);
  });

  test(`${platform}: distinct force action skips grace and kills only the captured tree`, async () => {
    const f = fixture({ windows });
    assert.equal(await f.stopProcessTree(f.identity, 'force'), 'stopped');
    assert.deepEqual(f.signals, [[102, 'SIGKILL'], [101, 'SIGKILL'], [100, 'SIGKILL']]);
    assert.deepEqual(f.waits, [100]);
    assert.equal(f.rows.has(500), true);
    for (const call of f.calls) {
      assert.ok(Array.isArray(call.args));
      assert.equal(call.options.timeout, 60000);
      assert.equal(call.options.env.LC_ALL, 'C');
      assert.equal(call.options.shell, undefined);
    }
    if (windows) {
      const scripts = f.calls.map(call => call.args.at(-1));
      assert.equal(scripts.filter(script => script.includes('GetProcessById')).length, 1);
      assert.equal(scripts.filter(script => script.includes('CreationDate')).length, 2, 'discovery and final verification only');
      assert.ok(scripts.some(script => script.includes('$p.Kill()') && script.includes('$p.Handle')));
      assert.ok(scripts.every(script => !/CloseMainWindow|taskkill|Stop-Process|\/T|node\.exe/.test(script)));
    } else {
      assert.deepEqual(Array.from(f.calls[0].args), ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'stat=']);
      assert.equal(f.calls[0].command, 'ps');
    }
  });

  test(`${platform}: distinct graceful action interrupts but never escalates survivors`, async () => {
    const f = fixture({ windows });
    assert.equal(await f.stopProcessTree(f.identity, 'graceful'), 'stuck');
    assert.deepEqual(f.signals, [[102, 'SIGINT'], [101, 'SIGINT'], [100, 'SIGINT']]);
    assert.deepEqual(f.waits, [3000]);
    assert.equal(f.rows.has(100), true);
    assert.equal(f.rows.has(500), true);
    assert.equal(await f.stopProcessTree(f.identity, 'force'), 'stopped');
    assert.equal(f.rows.has(102), false);
  });

  test(`${platform}: retry reports already gone when all previously retained processes exited naturally`, async () => {
    const f = fixture({ windows });
    assert.equal(await f.stopProcessTree(f.identity, 'graceful'), 'stuck');
    for (const pid of [100, 101, 102]) f.rows.delete(pid);
    f.signals.length = 0;
    f.waits.length = 0;
    assert.equal(await f.stopProcessTree(f.identity, 'force'), 'gone');
    assert.deepEqual(f.signals, []);
    assert.deepEqual(f.waits, []);
  });

  test(`${platform}: cooperative graceful exit is verified without force`, async () => {
    const f = fixture({ windows, onSignal({ pid, signal, rows }) {
      assert.equal(signal, 'SIGINT');
      rows.delete(pid);
    } });
    assert.equal(await f.stopProcessTree(f.identity, 'graceful'), 'stopped');
    assert.equal(f.signals.length, 3);
  });

  test(`${platform}: absent/reused root receives no signal`, async () => {
    for (const reused of [false, true]) {
      const f = fixture({ windows });
      if (reused) f.rows.get(100).started = windows ? winLater : later;
      else f.rows.delete(100);
      assert.equal(await f.stopProcessTree(f.identity), 'gone');
      assert.deepEqual(f.signals, []);
    }
  });

  test(`${platform}: launch capture retains known children even if the launcher exits before any stop`, async () => {
    const f = fixture({ windows });
    const captured = await f.captureProcess(100);
    f.rows.delete(100);
    f.rows.get(101).ppid = 1;
    assert.equal(await f.stopProcessTree(captured, 'force'), 'stopped');
    assert.deepEqual(f.signals, [[102, 'SIGKILL'], [101, 'SIGKILL']]);
    assert.equal(f.rows.has(500), true);
  });

  test(`${platform}: retains reparented children after graceful launcher exit for force retry`, async () => {
    const f = fixture({ windows, onSignal({ pid, force, rows }) {
      if (force || pid === 100) rows.delete(pid);
      if (pid === 100 && !force) rows.get(101).ppid = 1;
    } });
    assert.equal(await f.stopProcessTree(f.identity, 'graceful'), 'stuck');
    assert.equal(f.rows.has(100), false);
    assert.equal(await f.stopProcessTree(f.identity, 'force'), 'stopped');
    assert.deepEqual(f.signals.filter(([, signal]) => signal === 'SIGKILL'), [[102, 'SIGKILL'], [101, 'SIGKILL']]);
  });

  test(`${platform}: records late verified descendants for retry even after reparenting`, async () => {
    const f = fixture({ windows, onWait({ ms, rows }) {
      if (ms === 3000) rows.set(103, { pid: 103, ppid: 102, started: windows ? winLater : later });
    } });
    assert.equal(await f.stopProcessTree(f.identity, 'graceful'), 'stuck');
    f.rows.delete(100);
    f.rows.get(101).ppid = 1;
    f.rows.get(103).ppid = 1;
    assert.equal(await f.stopProcessTree(f.identity, 'force'), 'stopped');
    assert.ok(f.signals.some(([pid, signal]) => pid === 103 && signal === 'SIGKILL'));
  });

  test(`${platform}: never adopts a reused descendant or its new children`, async () => {
    const f = fixture({ windows });
    assert.equal(await f.stopProcessTree(f.identity, 'graceful'), 'stuck');
    f.rows.get(101).started = windows ? winLater : later;
    f.rows.get(101).ppid = 1;
    f.rows.set(103, { pid: 103, ppid: 101, started: windows ? winLater : later });
    assert.equal(await f.stopProcessTree(f.identity, 'force'), 'stuck');
    assert.ok(!f.signals.some(([pid, signal]) => [101, 103].includes(pid) && signal === 'SIGKILL'));
  });

  test(`${platform}: unverified descendants after force remain untouched and report incomplete cleanup`, async () => {
    const f = fixture({ windows, onWait({ rows }) {
      rows.set(103, { pid: 103, ppid: 100, started: windows ? winLater : later });
    } });
    assert.equal(await f.stopProcessTree(f.identity, 'force'), 'stuck');
    assert.ok(!f.signals.some(([pid]) => pid === 103));
  });

  test(`${platform}: unsafe descendants and incomplete inventories fail before signaling`, async () => {
    const f = fixture({ windows });
    f.rows.get(900).ppid = 101;
    await assert.rejects(f.stopProcessTree(f.identity), /Unsafe/);
    assert.deepEqual(f.signals, []);
    f.rows.delete(900);
    await assert.rejects(f.stopProcessTree(f.identity), /Incomplete/);
  });

  test(`${platform}: enumeration failures are errors, not absence`, async () => {
    const f = fixture({ windows, commandError: Object.assign(new Error('permission denied'), { code: 'EPERM' }) });
    await assert.rejects(f.captureProcess(100), /permission denied/);
    await assert.rejects(f.stopProcessTree(f.identity), /permission denied/);
    assert.deepEqual(f.signals, []);
  });

  test(`${platform}: failed force retains authenticated children when only launcher exits`, async () => {
    let allowChildren = false;
    const f = fixture({ windows, onSignal({ pid, rows }) {
      if (pid === 100 || allowChildren) rows.delete(pid);
      if (pid === 100) rows.get(101).ppid = 1;
    } });
    assert.equal(await f.stopProcessTree(f.identity, 'force'), 'stuck');
    allowChildren = true;
    assert.equal(await f.stopProcessTree(f.identity, 'force'), 'stopped');
    assert.equal(f.rows.has(500), true);
  });
}

test('Unix: revalidates each identity immediately before killing', async () => {
  const f = fixture({ onRead({ reads, rows }) {
    if (reads === 2) { rows.get(102).started = later; rows.get(102).ppid = 1; }
  } });
  assert.equal(await f.stopProcessTree(f.identity), 'stopped');
  assert.ok(!f.signals.some(([pid]) => pid === 102));
});

test('Unix: EPERM rejects; ESRCH races are verified with the final inventory', async () => {
  for (const code of ['EPERM', 'ESRCH']) {
    const f = fixture({ onSignal({ pid, rows }) {
      if (code === 'ESRCH') rows.delete(pid);
      throw Object.assign(new Error(code), { code });
    } });
    if (code === 'EPERM') await assert.rejects(f.stopProcessTree(f.identity), /EPERM/);
    else assert.equal(await f.stopProcessTree(f.identity), 'stopped');
  }
});

test('Unix: zombies are gone; malformed inventory fails closed', async () => {
  const f = fixture();
  f.rows.get(100).dead = true;
  assert.equal(await f.stopProcessTree(f.identity), 'gone');
  await assert.rejects(f.captureProcess(100), /gone/);
  const malformed = fixture({ output: '100 1 invalid birth' });
  await assert.rejects(malformed.stopProcessTree(malformed.identity), /Invalid ps/);
});

test('Windows: stale ParentProcessId cannot attach an older process to a reused root PID', async () => {
  const f = fixture({ windows: true });
  f.identity.started = winLater;
  f.rows.get(100).started = winLater;
  assert.equal(await f.stopProcessTree(f.identity), 'stopped');
  assert.deepEqual(f.signals, [[100, 'SIGKILL']]);
  assert.equal(f.rows.has(101), true);
});

test('Windows: unavailable console never silently falls back to force', async () => {
  const f = fixture({ windows: true, consoleError: new Error('Graceful stop unavailable: shared console') });
  await assert.rejects(f.stopProcessTree(f.identity, 'graceful'), /unavailable/);
  assert.deepEqual(f.signals, []);
  assert.equal(await f.stopProcessTree(f.identity, 'force'), 'stopped');
});

test('Windows: missing selected birth identity fails closed', async () => {
  const f = fixture({ windows: true });
  f.rows.get(101).started = '';
  await assert.rejects(f.stopProcessTree(f.identity), /identity/);
});

test('post-signal enumeration failure cannot claim successful cleanup', async () => {
  const f = fixture({ onWait({ rows }) { rows.delete(900); } });
  await assert.rejects(f.stopProcessTree(f.identity, 'graceful'), /Incomplete/);
  assert.ok(f.signals.every(([, signal]) => signal === 'SIGINT'));
});
