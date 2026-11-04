// Renders buffer snapshots into a framed HTML page and captures it as PNG
// with agent-browser (headless Chromium, 2x scale).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HERE } from './lib.mjs';

const FONT_DIR = `${process.env.HOME}/Library/Fonts`;
const BG = '#11141a';
const FG = '#d4d7dd';
// One Dark-ish 16-color palette for indexed colors; 256-color cube computed.
const BASE16 = ['#1e2127', '#e06c75', '#98c379', '#d19a66', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'];
function pal(i) {
  if (i < 16) return BASE16[i];
  if (i < 232) { const v = i - 16; const c = n => (n ? n * 40 + 55 : 0); return `rgb(${c(Math.floor(v / 36))},${c(Math.floor(v / 6) % 6)},${c(v % 6)})`; }
  const g = 8 + (i - 232) * 10; return `rgb(${g},${g},${g})`;
}
const css = c => (c == null ? null : typeof c === 'number' ? pal(c) : c);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const lineText = cells => cells.map(c => c.ch).join('').replace(/\s+$/, '');
export const isBlank = cells => !lineText(cells) && cells.every(c => c.bg == null);

function lineHTML(cells) {
  let out = '', run = '', key = null;
  const flush = () => { if (run) out += key ? `<span style="${key}">${esc(run)}</span>` : esc(run); run = ''; };
  for (const c of cells) {
    let fg = css(c.fg), bg = css(c.bg);
    if (c.inverse) [fg, bg] = [bg ?? BG, fg ?? FG];
    const st = [fg && `color:${fg}`, bg && `background:${bg}`, c.bold && 'font-weight:700', c.italic && 'font-style:italic', c.underline && 'text-decoration:underline', c.dim && 'opacity:.55'].filter(Boolean).join(';');
    if (st !== key) { flush(); key = st; }
    run += c.ch;
  }
  flush();
  return out || ' ';
}

// Select rows of a snapshot. Spec: { from?: RegExp|number, to?: RegExp|number,
// footer?: n } — `from`/`to` match line text (inclusive); `footer` appends the
// last n non-blank rows; blank runs collapse to one row; edges are trimmed.
export function rows(snap, { from, to, footer = 0, box = false } = {}) {
  const L = snap.lines;
  const find = (m, start = 0) => typeof m === 'number' ? m : L.findIndex((l, i) => i >= start && m.test(lineText(l)));
  let a = from == null ? 0 : find(from);
  let b = to == null ? L.length - 1 : find(to, a);
  if (a < 0 || b < 0) throw new Error(`rows(): ${a < 0 ? from : to} not found in\n${L.map(lineText).join('\n')}`);
  const picked = L.slice(a, b + 1).map((cells, i) => ({ cells, y: a + i }));
  if (footer) {
    let end = L.length - 1; while (end > 0 && isBlank(L[end])) end--;
    const start = end - footer + 1;
    if (start > b + 1) picked.push({ gap: true });
    for (let y = Math.max(start, b + 1); y <= end; y++) picked.push({ cells: L[y], y });
  }
  const covered = new Set((snap.images ?? []).flatMap(im => Array.from({ length: im.r }, (_, k) => im.y + k)));
  const out = [];
  for (const r of picked) {
    if (r.gap) { out.push(r); continue; }
    r.images = (snap.images ?? []).filter(im => im.y === r.y);
    if (!covered.has(r.y) && isBlank(r.cells) && (out.length === 0 || (out.at(-1).cells && isBlank(out.at(-1).cells)))) continue;
    out.push(r);
  }
  while (out.length && out.at(-1).cells && isBlank(out.at(-1).cells) && !covered.has(out.at(-1).y)) out.pop();
  if (box) {
    // Crop columns to the overlay drawn on the `from` row (its left and right border).
    const t = lineText(L[a]); const x0 = t.search(/\S/); const x1 = t.length;
    for (const r of out) if (r.cells) r.cells = r.cells.slice(x0, x1);
    return { cols: x1 - x0, rows: out };
  }
  return { cols: snap.cols, rows: out };
}

// panels: [{ label?, title, view: rows(...), highlight?: RegExp[] }]
export function page({ panels, caption }) {
  const body = panels.map(p => {
    const lines = p.view.rows.map(r => {
      if (r.gap) return `<div class="ln gap">⋯</div>`;
      const t = lineText(r.cells);
      const hl = (p.highlight ?? []).some(re => re.test(t));
      const imgs = (r.images ?? []).map(im => `<img class="kimg" src="${im.src}" style="left:${im.x}ch;width:${im.c}ch;height:${im.r * 1.2}em">`).join('');
      return `<div class="ln${hl ? ' hl' : ''}">${lineHTML(r.cells)}${imgs}</div>`;
    }).join('');
    return `${p.label ? `<div class="label ${p.labelKind ?? ''}">${esc(p.label)}</div>` : ''}
<div class="win"><div class="bar"><i></i><i></i><i></i><span>${esc(p.title ?? 'pi')}</span></div>
<div class="term" style="width:${p.view.cols}ch">${lines}</div></div>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Cask;src:url("file://${FONT_DIR}/CaskaydiaCoveNerdFont-Regular.ttf")}
@font-face{font-family:Cask;font-weight:700;src:url("file://${FONT_DIR}/CaskaydiaCoveNerdFont-Bold.ttf")}
@font-face{font-family:Cask;font-style:italic;src:url("file://${FONT_DIR}/CaskaydiaCoveNerdFont-Italic.ttf")}
html,body{margin:0;background:transparent}
.shot{display:inline-block;padding:28px;background:linear-gradient(135deg,#2b3240,#1a1f29);font-family:-apple-system,"Segoe UI",sans-serif}
.label{color:#c9d1d9;font-size:15px;font-weight:600;margin:0 0 8px 4px;letter-spacing:.2px}
.label.before{color:#8b949e}.label.after{color:#7ee787}
.win+.label{margin-top:22px}
.win{background:${BG};border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.08);overflow:hidden}
.bar{height:30px;display:flex;align-items:center;gap:7px;padding:0 12px;background:#1b1f27;border-bottom:1px solid #262b35}
.bar i{width:11px;height:11px;border-radius:50%;background:#3a3f4b}
.bar i:nth-child(1){background:#ff5f57}.bar i:nth-child(2){background:#febc2e}.bar i:nth-child(3){background:#28c840}
.bar span{flex:1;text-align:center;color:#8b949e;font-size:12.5px;margin-right:52px}
.term{font-family:Cask,monospace;font-size:14px;line-height:1.2;color:${FG};padding:12px 14px 14px;white-space:pre;box-sizing:content-box;font-variant-ligatures:none;font-feature-settings:"calt" 0,"liga" 0}
.ln{min-height:1.2em;position:relative}
.ln.hl{background:rgba(255,214,102,.07);box-shadow:-14px 0 0 0 rgba(255,214,102,.07),14px 0 0 0 rgba(255,214,102,.07),inset 0 0 0 0 transparent}
.ln.hl::before{content:"";position:absolute;left:-14px;top:0;bottom:0;width:3px;background:#e5c07b}
.kimg{position:absolute;top:0;object-fit:contain;object-position:left top;border-radius:4px;z-index:1}
.ln.gap{color:#4b5263;text-align:center}
.cap{color:#8b949e;font-size:13px;margin:14px 4px 0;max-width:${Math.max(...panels.map(p => p.view.cols))}ch}
</style><div class="shot">${body}${caption ? `<div class="cap">${esc(caption)}</div>` : ''}</div>`;
}

const AB = (...a) => execFileSync('agent-browser', ['--session', 'pi-shots', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false;
export function capture(name, html, out) {
  const dir = join(HERE, 'html'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.html`);
  writeFileSync(file, html);
  if (!ready) { AB('open', 'about:blank'); AB('set', 'viewport', '2400', '1600', '2'); ready = true; }
  AB('open', `file://${file}`);
  AB('wait', '250');
  AB('screenshot', '.shot', out);
  return out;
}
export const closeBrowser = () => { try { AB('close'); } catch {} };
