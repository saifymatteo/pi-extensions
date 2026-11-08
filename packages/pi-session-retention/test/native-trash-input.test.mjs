import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHost, isolatedEnvironment } from '../../../scripts/environment.mjs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// Spawn the host the way scripts/screenshots does: node + bundled cli.js. resolveHost('pi')
// is a .cmd shim on Windows, which ConPTY cannot exec directly.
const STOCK = fileURLToPath(new URL('../../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));

const SCREENSHOTS = new URL('../../../scripts/screenshots/package.json', import.meta.url);
const instrument = `
  import { writeFileSync, renameSync } from 'node:fs';
  const publish = value => { writeFileSync(report + '.tmp', JSON.stringify(value)); renameSync(report + '.tmp', report); };
`;

const DIALOG_PROBE = `
  import { SessionTrashDialog } from dialogModule;
  import { DIALOG_OVERLAY } from overlayModule;
  const choices = Array.from({ length: 40 }, (_, i) => ({ value: 'family-' + i, label: 'Family ' + i, description: 'fixture', search: 'fixture' }));
  export default function (pi) {
    pi.registerCommand('paging-probe', { getArgumentCompletions: () => choices.map(c => c.value), handler: async (_args, ctx) => {
      await ctx.ui.custom((tui, theme, kb, done) => {
        let lastInput = '';
        const dialog = new SessionTrashDialog(tui, theme, kb, choices, '', done, async () => ({
          name: 'Paging fixture', cwd: '/fixture/project', truncated: false,
          firstRequest: Array.from({ length: 100 }, (_, i) => 'paragraph ' + i).join('\\n\\n'), recent: [],
        }));
        const render = dialog.render.bind(dialog), input = dialog.handleInput.bind(dialog);
        dialog.handleInput = data => { lastInput = data; input(data); };
        dialog.render = width => {
          const lines = render(width);
          publish({ mode: tui.mode, lastInput, top: dialog.previewScroll.scrollTop,
            viewport: dialog.previewScroll.viewportHeight,
            overlayFocused: typeof tui.isOverlayFocused === 'function' ? tui.isOverlayFocused() : null,
            pageKeys: kb.getKeys('tui.select.pageDown') });
          return lines;
        };
        return dialog;
      }, DIALOG_OVERLAY);
      pi.shutdown();
    } });
  }
`;

test('native fullscreen overlay routes physical paging input to Trash', { skip: process.env.PI_NATIVE_RETENTION !== '1' || process.platform !== 'win32', timeout: 120_000 }, async t => {
  let pty;
  try { pty = createRequire(SCREENSHOTS)('node-pty'); } catch { t.skip('requires node-pty for isolated terminal input'); return; }
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'pi-trash-input-'));
  const report = join(home, 'report.json');
  let child, output = '';
  let latest;
  const readFrame = () => { try { latest = JSON.parse(readFileSync(report, 'utf8')); } catch { /* Between atomic publish steps. */ } return latest; };
  const poll = (predicate, label) => new Promise((resolve, reject) => {
    const started = Date.now();
    const check = setInterval(() => {
      const frame = readFrame();
      if (frame && predicate(frame)) { clearInterval(check); resolve(frame); return; }
      if (Date.now() - started > 10_000) { clearInterval(check); reject(new Error(`${label} (last frame: ${JSON.stringify(latest)})\n${output.slice(-2000)}`)); }
    }, 50);
  });
  try {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ tuiMode: 'fullscreen', quietStartup: true }));
    const dialogModule = fileURLToPath(new URL('../src/dialog.ts', import.meta.url));
    const overlayModule = fileURLToPath(new URL('../src/lib/dialog.ts', import.meta.url));
    const probe = join(home, 'probe.mjs');
    writeFileSync(probe, `${instrument}\nconst report = ${JSON.stringify(report)};\n${DIALOG_PROBE.replaceAll('dialogModule', JSON.stringify(dialogModule)).replaceAll('overlayModule', JSON.stringify(overlayModule))}`);
    child = pty.spawn(process.execPath, [STOCK, '--offline', '--no-session', '--no-approve', '--no-extensions', '--no-skills', '--no-context-files', '--no-themes', '--no-mcp', '--no-prompt-templates', '-e', probe], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: home,
      env: { ...isolatedEnvironment(home), TERM: 'xterm-256color', TERM_PROGRAM: 'paging-fixture', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
    });
    child.onData(data => { output = (output + data).slice(-12000); });
    // The editor only listens after startup settles; typing earlier drops keystrokes.
    // Type after a fixed settle, then retry until the dialog itself renders.
    await new Promise(resolve => setTimeout(resolve, 3000));
    const deadline = Date.now() + 45_000;
    while (!output.includes('Session Trash')) {
      if (Date.now() > deadline) throw new Error(`Dialog never appeared\n${output.slice(-2000)}`);
      child.write('/paging-probe\r');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    child.write('\r');
    const opened = await poll(frame => frame.viewport > 0, 'preview never opened');
    assert.equal(opened.mode, 'fullscreen');
    child.write('\x1b[6~');
    const down = await poll(frame => frame.lastInput === '\x1b[6~' && frame.top > 0, 'Page Down never reached the dialog');
    assert.equal(down.top, down.viewport);
    child.write('\x1b[5~');
    await poll(frame => frame.lastInput === '\x1b[5~' && frame.top === 0, 'Page Up never reached the dialog');
  } finally {
    // Kill only this test's spawned process tree — never a blanket image-name kill.
    if (child?.pid) {
      try { child.kill(); } catch { /* The probe may have exited already. */ }
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch { /* Already dead. */ }
    }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows can lag releasing the cwd; temp dirs are swept eventually. */ }
  }
});
