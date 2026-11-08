import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui';
import { isolatedEnvironment, resolveHost } from '../../../scripts/environment.mjs';

test('native Pi host validates cache identities, extracts previews and renders the two-view dialog', { skip: process.env.PI_NATIVE_RETENTION !== '1' }, () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'pi-native-trash-cache-'));
  try {
    const id = '12345678-1234-1234-1234-123456789abc';
    const root = join(home, 'trash'), path = join(root, id, '0.jsonl'), report = join(home, 'result.json');
    mkdirSync(join(root, id), { recursive: true });
    const project = join(home, 'nested-project');
    const firstRequest = ['**native first prompt**', '',
      'Wrapped paragraph ' + 'native wrapping words '.repeat(12), '',
      '```js', 'const nativeCode = 42;', '```', '',
      ...Array.from({ length: 35 }, (_, index) => `request line ${index + 1}  `),
    ].join('\n');
    writeFileSync(path, [
      { type: 'session', id: 'native-fixture', cwd: project },
      { type: 'message', message: { role: 'user', content: firstRequest } },
      ...Array.from({ length: 7 }, (_, index) => ({ type: 'message', message: {
        role: index % 2 ? 'user' : 'assistant',
        content: `**recent message ${index + 1}**\n\nrecent continuation ${index + 1}`,
      } })),
      { type: 'session_info', name: 'native name' },
    ].map(JSON.stringify).join('\n') + '\n');
    const module = fileURLToPath(new URL('../src/search-cache.ts', import.meta.url));
    const previewModule = fileURLToPath(new URL('../src/preview.ts', import.meta.url));
    const dialogModule = fileURLToPath(new URL('../src/dialog.ts', import.meta.url));
    const probe = join(home, 'probe.ts');
    writeFileSync(probe, `
      import { TrashSearchCache } from ${JSON.stringify(module)};
      import { loadTrashPreview } from ${JSON.stringify(previewModule)};
      import { SessionTrashDialog } from ${JSON.stringify(dialogModule)};
      import { getKeybindings, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
      import { lstat, writeFile } from 'node:fs/promises';
      import { setImmediate } from 'node:timers/promises';
      export default function(pi) { pi.on('session_start', async (_event, ctx) => {
        try {
          await setImmediate(undefined, { signal: new AbortController().signal });
          const info = await lstat(${JSON.stringify(path)}, { bigint: true });
          const batch = { manifest: { version: 1, id: '${id}', ready: true, trashedAt: 123, files: [{original:'native.jsonl',stored:'0.jsonl'}] }, missing: [] };
          const cache = new TrashSearchCache(${JSON.stringify(root)});
          const cold = await cache.read(batch, new AbortController().signal);
          const warm = await cache.read(batch, new AbortController().signal);
          const excerpt = await loadTrashPreview(${JSON.stringify(root)}, batch, 0, new AbortController().signal);
          let requested, signal, loads = 0, release;
          const pending = new Promise(resolve => { release = resolve; });
          const keys = getKeybindings();
          const dialog = new SessionTrashDialog({terminal:{rows:24},requestRender(){}}, ctx.ui.theme, keys, [{value:'${id}',label:'stale indexed name',description:'fixture',search:'native name',members:1}], '', value=>{requested=value;}, async(_id, _member, activeSignal)=>{
            signal = activeSignal;
            if (++loads > 1) await pending;
            return excerpt;
          });
          dialog.handleInput('\\r');
          await setImmediate();
          const rendered = dialog.render(80).join('\\n');
          const snapshot = () => dialog.render(80).map(stripTerminalSequences);
          const frames = [snapshot()];
          // Walk every body row, not only the first line of each Markdown excerpt.
          for (let index = 0; index < 160; index++) {
            dialog.handleInput('\\x1b[B');
            const next = snapshot();
            if (JSON.stringify(next) === JSON.stringify(frames.at(-1))) break;
            frames.push(next);
          }
          const bottom = snapshot();
          dialog.handleInput('\\x1b');
          const searchAgain = snapshot();
          dialog.handleInput('\\r');
          await setImmediate();
          dialog.handleInput('\\x12');
          let drained = false;
          const draining = dialog.drain().then(() => { drained = true; });
          await setImmediate();
          const drainedBeforeRelease = drained;
          release();
          await draining;
          const afterDrain = snapshot();
          const completeDialog = new SessionTrashDialog({terminal:{rows:24},requestRender(){}}, ctx.ui.theme,
            keys,
            [{value:'${id}',label:'stale indexed name',description:'fixture',search:'native name',members:1}], '', ()=>{},
            async()=>({...excerpt, cwd:'/native/project', truncated:false}));
          completeDialog.handleInput('\\r');
          await setImmediate();
          const completeTop = completeDialog.render(80).map(stripTerminalSequences);
          completeDialog.handleInput('\\x1b[6~');
          const completeScrolled = completeDialog.render(80).map(stripTerminalSequences);
          completeDialog.handleInput('\\x1b[5~');
          const completeBackToTop = completeDialog.render(80).map(stripTerminalSequences);
          await completeDialog.drain();
          await writeFile(${JSON.stringify(report)}, JSON.stringify({ cold, warm, excerpt, rendered, frames, bottom, searchAgain, afterDrain, completeTop, completeScrolled, completeBackToTop,
            widths: frames.flat().map(visibleWidth), requested, aborted: signal.aborted, drainedBeforeRelease, drained, loads,
            nanoseconds: typeof info.mtimeNs === 'bigint' && typeof info.ctimeNs === 'bigint' }));
        } catch(error) { await writeFile(${JSON.stringify(report)}, JSON.stringify({error:String(error)})); }
        ctx.shutdown();
      }); }
    `);
    const { command } = resolveHost();
    const env = { ...isolatedEnvironment(home), FORCE_COLOR: '1' };
    delete env.NO_COLOR; // The piped native-host probe must still exercise styling.
    const result = spawnSync(command, ['--offline', '--mode', 'rpc', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-mcp', '--no-context-files', '--no-session', '--no-approve', '-e', probe], {
      cwd: home, env, encoding: 'utf8', input: '', timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    const data = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(data.error, undefined);
    assert.equal(data.nanoseconds, true);
    assert.equal(data.cold.title, 'native name');
    assert.deepEqual(data.warm, data.cold);
    assert.ok(data.warm.search.includes('native first prompt'));
    assert.equal(data.excerpt.firstRequest, firstRequest);
    assert.equal(data.excerpt.cwd, project);
    assert.equal(data.excerpt.truncated, true);
    assert.equal(data.excerpt.recent.length, 6);
    assert.equal(data.excerpt.name, 'native name');
    assert.ok(data.rendered.includes('native first prompt'));
    assert.ok(!data.rendered.includes('**native first prompt**'));
    assert.match(data.rendered, /\x1b\[1m/);
    assert.ok(data.rendered.includes('Ctrl+R'));
    const top = data.frames[0];
    assert.match(top[0], /Session Trash › native name/);
    assert.ok(!top[0].includes('stale indexed name'));
    assert.equal(top[1].slice(3, -3).trim(), 'nested-project · Session 1/1 · read-only');
    assert.equal(top[2].slice(3, -3).trim(), visibleWidth(project) > 74 ? `…${sliceByColumn(project, visibleWidth(project) - 73, 73, true)}` : project);
    assert.equal(top[3].slice(3, -3).trim(), '');
    assert.equal(top.at(-4), '┣' + '━'.repeat(78) + '┫');
    assert.equal(top.at(-3).slice(3, -3).trim(), 'Preview only · Some content shortened');
    assert.match(top.at(-2), /Ctrl\+R restore all 1 · Esc back/);
    assert.ok(data.frames.length > 20, 'the excerpt must actually scroll');
    assert.notDeepEqual(data.bottom.slice(4, -4), top.slice(4, -4));
    for (const frame of data.frames) {
      assert.deepEqual(frame.slice(0, 4), top.slice(0, 4), 'header stays fixed while scrolling');
      assert.deepEqual(frame.slice(-4), top.slice(-4), 'status and controls stay fixed while scrolling');
    }
    assert.ok(data.widths.every(width => width === 80), 'all rendered rows fill the frame');
    const body = [...new Set(data.frames.flatMap(frame => frame.slice(4, -4).map(line => line.slice(3, -3).trimEnd())))];
    for (const label of ['FIRST REQUEST', 'RECENT MESSAGES']) {
      assert.ok(body.includes(`── ${label} ` + '─'.repeat(74 - label.length - 4)), `${label} is a full-width rule`);
    }
    assert.ok(body.includes('You'));
    assert.ok(body.includes('Assistant'));
    assert.ok(body.includes('│  native first prompt'), 'native Markdown removes bold markers inside the rail');
    assert.ok(body.some(line => line.startsWith('│  ') && line.includes('const nativeCode = 42;')), 'fenced code uses native Markdown inside the rail');
    const wrapped = body.filter(line => line.includes('native wrapping words'));
    assert.ok(wrapped.length > 1, 'paragraph wraps into multiple body rows');
    assert.ok(wrapped.every(line => line.startsWith('│  ')), 'wrapped continuation rows retain rails');
    for (const line of body) {
      if (!line || line === 'You' || line === 'Assistant' || line.startsWith('── ')) continue;
      assert.match(line, /^│(?:  |$)/, `every Markdown body row (including blank lines) has a rail: ${line}`);
    }
    assert.ok(data.bottom.some(line => line.includes('recent continuation 7')));
    assert.equal(data.completeTop[1].slice(3, -3).trim(), 'project · Session 1/1 · read-only');
    assert.equal(data.completeTop[2].slice(3, -3).trim(), '/native/project');
    assert.equal(data.completeTop.at(-3).slice(3, -3).trim(), 'Preview only · Current branch · Tools/thinking omitted');
    assert.notDeepEqual(data.completeScrolled.slice(4, -4), data.completeTop.slice(4, -4));
    assert.deepEqual(data.completeScrolled.slice(0, 4), data.completeTop.slice(0, 4));
    assert.deepEqual(data.completeScrolled.slice(-4), data.completeTop.slice(-4));
    assert.deepEqual(data.completeBackToTop, data.completeTop, 'real native Page Up reverses Page Down');
    assert.ok(data.searchAgain.some(line => line.includes('Search:')));
    assert.ok(data.searchAgain.some(line => line.includes('stale indexed name')));
    assert.equal(data.requested, id);
    assert.equal(data.loads, 2);
    assert.equal(data.aborted, true);
    assert.equal(data.drainedBeforeRelease, false, 'drain waits for the aborted in-flight preview');
    assert.equal(data.drained, true);
    assert.ok(data.afterDrain.some(line => line.includes('Loading preview…')), 'late completion cannot replace disposed preview');
    assert.equal(JSON.parse(readFileSync(join(root, '.search-cache', `${id}.json`), 'utf8')).version, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
