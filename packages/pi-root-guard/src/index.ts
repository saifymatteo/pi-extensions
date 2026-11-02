/**
 * pi-root-guard.ts — stop the agent from writing into the two agent config
 * roots: the Pi root (PI_CODING_AGENT_DIR, default ~/.pi/agent) and the Claude
 * Code root (CLAUDE_CONFIG_DIR, default ~/.claude). The Pi-root rule is what
 * caused earlier research clutter (pkgextract.py, *.html, *.tgz,
 * repo_tree.json, ...) in D:\Pi.
 *
 * Rules (these two roots only; project folders are not guarded):
 *   - File writes inside the Pi root are BLOCKED except under the managed
 *     agents/, extensions/, skills/, npm/, git/, and temp/ subdirectories.
 *     Refused with a reason directing the agent to a temp dir.
 *   - File writes inside the Claude root are BLOCKED except where Claude Code
 *     itself writes without asking (plans/, jobs/<id>/tmp/, memory *.md), so
 *     Pi can stand in for Claude Code as a harness. Claude Code prompts for
 *     the rest; here they are always refused (its dontAsk behaviour) — asking
 *     the user is pi-guardrails' job.
 *
 * Intercepts tool_call for `write`/`edit` (exact `path`) plus a conservative
 * `bash` heuristic (redirects, tee, curl -o, cp/mv dst, git clone, tar -x -C).
 * ponytail: bash parsing is heuristic, not a full shell parser — subprocess
 * writes to arbitrary computed paths can slip through. The deterministic
 * fix for those is agent temp-dir discipline, not a shell parser.
 *
 * Cwd independence: the roots are resolved to an ABSOLUTE path (env var expanded,
 * tilde expanded, homedir fallback), so the guard protects the Pi root no
 * matter where the session cwd is. Candidate paths get the same tilde/env
 * expansion, and relative paths resolve against the session cwd (ctx.cwd)
 * rather than the launcher's process.cwd().
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const norm = (p: string): string => p.replace(/\\/g, '/')
const lower = (p: string): string => norm(p).toLowerCase()

const isUnder = (p: string, dir: string): boolean =>
  p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')

/** Normalize git-bash `/d/...` (and `D:\`) to drive form `D:/...`. */
const drivePath = (raw: string): string =>
  raw.replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, (_m, c: string) => c.toUpperCase() + ':/')

/**
 * Expand `~/...` to the real home dir and defined environment variables
 * ($VAR, ${VAR} — bash style) in a candidate path. Undefined variables are
 * left untouched: this mirrors what bash would actually write, and keeps the
 * guard conservative without inventing paths the shell would never produce.
 */
function expandPath(raw: string): string {
  let p = raw
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = join(homedir(), p.slice(1))
  }
  p = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced, plain) => {
    const v = process.env[braced ?? plain]
    return v === undefined ? m : v
  })
  return p
}

/** Absolute, normalized root from an env override, else ~/<fallback...>. */
function absRoot(override: string | undefined, ...fallback: string[]): string {
  const raw = override?.trim()
  const r = drivePath(raw ? expandPath(raw) : join(homedir(), ...fallback))
  return norm(resolve(homedir(), r)) // normalize absolute paths too; relative overrides anchor at home
}

/** Absolute, normalized Pi root: PI_CODING_AGENT_DIR if set, else ~/.pi/agent. */
export function envRoot(): string {
  return absRoot(process.env.PI_CODING_AGENT_DIR, '.pi', 'agent')
}

/** Absolute, normalized Claude Code root: CLAUDE_CONFIG_DIR if set, else ~/.claude. */
export function claudeRoot(): string {
  return absRoot(process.env.CLAUDE_CONFIG_DIR, '.claude')
}

const GUARD_ROOT = envRoot()
const CLAUDE_ROOT = claudeRoot()
const TEMP = process.env.PI_GUARDRAIL_TEMP || (GUARD_ROOT ? GUARD_ROOT + '/temp' : 'temp')
// temp/ is the guard's own escape hatch.
const PI_ALLOW = ['agents', 'extensions', 'skills', 'npm', 'git', 'temp']

// Claude root paths Claude Code writes without asking, copied from
// https://code.claude.com/docs/en/permission-modes#protected-paths (2026-10-26).
const CLAUDE_EXCEPTIONS = [
  /^plans\//,
  /^jobs\/[^/]+\/tmp\//,
  /^projects\/[^/]+\/memory\/.+\.md$/,
  /^agent-memory\/.+\.md$/,
]

/** true when an absolute path is inside the Claude root and not one of Claude Code's exceptions. */
export function protectedPath(absPath: string, root = CLAUDE_ROOT): boolean {
  if (!root) return false
  const a = lower(resolve(drivePath(absPath)))
  const r = lower(resolve(drivePath(root)))
  if (!isUnder(a, r)) return false
  const rel = a.slice(r.length + 1)
  return !CLAUDE_EXCEPTIONS.some((re) => re.test(rel))
}

/** true when an absolute path is inside the guarded root and NOT allowed. */
export function blocked(absPath: string, root = GUARD_ROOT, allow = PI_ALLOW): boolean {
  if (!root) return false
  const a = lower(resolve(drivePath(absPath)))
  const r = lower(resolve(drivePath(root)))
  if (!isUnder(a, r)) return false
  return !allow.some((dir) => isUnder(a, lower(join(r, dir))))
}

/** Resolve a possibly-relative path against a base and return abs path iff blocked. */
function blockedResolved(raw: string, base: string): string | null {
  try {
    const d = drivePath(expandPath(raw))
    const abs = resolve(drivePath(base), d)
    return blocked(abs) || protectedPath(abs) ? abs : null
  } catch {
    return null
  }
}

/** Cwd after a leading `cd <dir>`; quoted occurrences inside other commands do not count. */
function baseDir(cmd: string, fallback: string): string {
  const cd = /^\s*cd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd)
  if (!cd) return fallback
  try {
    return resolve(drivePath(fallback), drivePath(expandPath(cd[1] ?? cd[2] ?? cd[3])))
  } catch {
    return fallback
  }
}

/** Scan simple commands in order; this remains a heuristic, not a shell parser. */
export function blockedBash(cmd: string, base: string = process.cwd()): string | null {
  // Preserve quoted/escaped separators instead of treating them as command boundaries.
  const commands = cmd.match(/(?:[^"';&|()\r\n\\]|\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'[^']*')+/g) ?? []
  let cwd = base
  for (const command of commands) {
    const ups: string[] = [] // candidate paths for this command's cwd only
    const pushRaw = (r: string | undefined): void => {
      if (r) ups.push(r)
    }

    // Match >> greedily so its second > cannot become the captured destination.
    const redir = /(?:^|\s)[12]?>>?\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g
    let m: RegExpExecArray | null
    while ((m = redir.exec(command))) pushRaw(m[1] ?? m[2] ?? m[3])

    // curl/wget -o/--output and curl -O (URL basename in cwd).
    const curl = /(?:curl|wget)\s+(?:.*\s)?(?:-o|--output)\s+"?([^\s"]+)"?/gi
    while ((m = curl.exec(command))) pushRaw(m[1])
    if (/(?:curl|wget)\s+-O\b/i.test(command)) ups.push('.')

    // Destinations are the last argument of this command, not of the whole script.
    const lastArg = (verbs: RegExp): string | null => {
      const idx = command.search(verbs)
      if (idx < 0) return null
      const args = command.slice(idx).match(/(?:"([^"]+)"|'([^']+)'|(\S+))/g) ?? []
      return args.length ? args[args.length - 1].replace(/^["']|["']$/g, '') : null
    }
    pushRaw(lastArg(/\bcp\s+/) ?? '')
    pushRaw(lastArg(/\bmv\s+/) ?? '')
    pushRaw(lastArg(/\btee\s+/) ?? '')
    pushRaw(lastArg(/\bgit\s+clone\s+/) ?? '')
    pushRaw(lastArg(/\btar\s+.*\s+-C\s+/) ?? '')

    for (const u of ups) {
      const hit = blockedResolved(u, cwd)
      if (hit) return hit
    }
    // Redirections occur before cd changes cwd; following commands use the new cwd.
    cwd = baseDir(command, cwd)
  }
  return null
}

export default function register(pi: any): void {
  const piReason = `writes to the Pi root are blocked by the pi-root-guard guardrail — put work artifacts in the temp dir (${TEMP}) instead.`
  const claudeReason = `writes to the Claude root (${CLAUDE_ROOT}) are blocked by the pi-root-guard guardrail — ask the user to make this change.`
  const reason = (hit: string): string => `[pi-root-guard] ${blocked(hit) ? piReason : claudeReason}`
  pi.on('tool_call', (event: any, ctx: any) => {
    try {
      const t = event?.toolName
      const inp = event?.input ?? {}
      // Session cwd (tools execute there) with process.cwd() as a fallback.
      const sessionCwd: string =
        ctx && typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : process.cwd()
      if (t === 'write' || t === 'edit') {
        const hit = typeof inp.path === 'string' ? blockedResolved(inp.path, sessionCwd) : null
        if (hit) return { block: true, reason: `${reason(hit)} (blocked path: ${hit})` }
      } else if (t === 'bash') {
        const cmd: string = typeof inp.command === 'string' ? inp.command : ''
        if (!cmd) return
        const hit = blockedBash(cmd, sessionCwd)
        if (hit) return { block: true, reason: `${reason(hit)} (blocked path: ${hit}, cmd: ${cmd.slice(0, 120)})` }
      }
    } catch {
      /* never break a turn over the guard itself */
    }
  })
}
