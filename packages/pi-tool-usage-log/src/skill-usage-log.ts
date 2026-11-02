/**
 * skill-usage-log.ts — track skill *use*, not just reads, so unused skills
 * can be identified for removal.
 *
 * A skill is considered USED when a successful SKILL.md read is followed by
 * another tool call while answering the same request, even in a later model
 * turn. This is an activity heuristic, not proof the instructions were followed.
 * A skill that is read then abandoned (no follow-up tool) is NOT counted.
 *
 * Emits two event kinds to <agent-home>/skill-usage.log
 * (defaults to ~/.pi/agent, or PI_CODING_AGENT_DIR):
 *   skill:load      — SKILL.md read (deduped once per session)
 *   skill:complete  — skill loaded AND had follow-up tool activity this request
 * Both events are deduped once per session. New TSV rows append the selected
 * agent model and thinking level to the legacy six fields. Timestamps use the
 * runtime's local timezone with explicit offsets; old UTC rows remain readable.
 *
 * /skill-usage summarizes the log across projects, sorted by used-session count.
 * It lists every installed skill (pi.getCommands() skill entries), so never-loaded skills show as 0/never.
 * Historical rows retain the old counting heuristic; they cannot be repaired.
 * `buildTracker()` is pure for testing; the default export wires it up to pi.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Markdown, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { agentMetadata, localTimestamp, logField, markdownCell, usageTimeFormat } from './lib/usage-log.ts'
import { DIALOG_OVERLAY, dialogRows, wheelAsArrows } from './lib/dialog.ts'

export interface TrackerEvent {
  event: 'skill:load' | 'skill:complete'
  skill: string
  path: string
  model?: string
  thinking?: string
}

export interface SkillTracker {
  handleRequestStart(): void
  handleToolCall(tool: string | undefined, metadata?: { model: string; thinking: string }): void
  handleSkillRead(path: string, metadata?: { model: string; thinking: string }): void
  handleTurnEnd(): TrackerEvent[]
}

/** Pure skill-usage state machine — no pi, no fs. Testable. */
export function buildTracker(onEvent?: (e: TrackerEvent) => void): SkillTracker {
  const sessionUsed = new Set<string>()
  const sessionLoaded = new Set<string>()
  const requestLoaded = new Map<string, string>()
  const requestUsed = new Map<string, { model: string; thinking: string } | undefined>()

  return {
    handleRequestStart() {
      requestLoaded.clear()
      requestUsed.clear()
    },
    handleToolCall(tool, metadata) {
      if (tool && tool !== 'think') {
        for (const skill of requestLoaded.keys()) {
          if (!requestUsed.has(skill)) requestUsed.set(skill, metadata && { ...metadata })
        }
      }
    },
    handleSkillRead(path, metadata) {
      const norm = normalize(path)
      // Same SKILL.md rule as compact-tools; keep legacy standalone skills too.
      const skill = norm.match(/(?:^|\/)([^/]+)\/SKILL\.md$/i)?.[1] ??
        norm.match(/(?:^|\/)skills\/([^/]+)\.md$/i)?.[1]
      if (!skill) return
      requestLoaded.set(skill, path)
      if (!sessionLoaded.has(skill)) {
        sessionLoaded.add(skill)
        onEvent?.({ event: 'skill:load', skill, path, ...metadata })
      }
    },
    handleTurnEnd() {
      const out: TrackerEvent[] = []
      for (const [skill, metadata] of requestUsed) {
        if (!sessionUsed.has(skill)) {
          sessionUsed.add(skill)
          out.push({ event: 'skill:complete', skill, path: requestLoaded.get(skill)!, ...metadata })
        }
      }
      out.forEach((event) => onEvent?.(event))
      return out
    },
  }
}

function normalize(p: string): string {
  return p.replaceAll('\\', '/')
}

export interface UsageRow {
  skill: string
  loads: number
  uses: number
  lastUsed: string | null
}

/** Counts sessions, not tool calls; accepts legacy six- and metadata eight-column TSV.
 *  `installed` names never seen in the log are added as zero rows, so unused skills are visible. */
export function summarizeUsage(log: string, installed: string[] = []): { skills: UsageRow[]; skipped: number } {
  const { skills, skipped } = summarizeLog(log)
  const seen = new Set(skills.map((row) => row.skill))
  const unused = [...new Set(installed)].filter((skill) => !seen.has(skill)).sort((a, b) => a.localeCompare(b))
  return { skills: [...skills, ...unused.map((skill) => ({ skill, loads: 0, uses: 0, lastUsed: null }))], skipped }
}

function summarizeLog(log: string, byAgent = false) {
  const rows = new Map<string, { row: UsageRow & { model?: string; thinking?: string }; loads: Set<string>; uses: Set<string> }>()
  let skipped = 0
  for (const line of log.split(/\r?\n/)) {
    if (!line) continue
    const fields = line.split('\t')
    const [timestamp, sid, , event, skill] = fields
    const time = Date.parse(timestamp)
    if ((fields.length !== 6 && fields.length !== 8) || !Number.isFinite(time) || !skill ||
        /[\x00-\x1f\x7f-\x9f]/.test(skill) ||
        (event !== 'skill:load' && event !== 'skill:complete')) {
      skipped++
      continue
    }
    const model = fields[6] || 'unknown'
    const thinking = fields[7] || 'unknown'
    const group = byAgent ? JSON.stringify([skill, model, thinking]) : skill
    let entry = rows.get(group)
    if (!entry) {
      entry = { row: { skill, loads: 0, uses: 0, lastUsed: null, ...(byAgent ? { model, thinking } : {}) }, loads: new Set(), uses: new Set() }
      rows.set(group, entry)
    }
    // Old logs can have an empty sid; do not merge their unrelated uses.
    const key = sid || timestamp
    if (event === 'skill:load') {
      entry.loads.add(key)
      entry.row.loads = entry.loads.size
    } else {
      entry.uses.add(key)
      entry.row.uses = entry.uses.size
      const usedAt = new Date(time).toISOString()
      if (!entry.row.lastUsed || usedAt > entry.row.lastUsed) entry.row.lastUsed = usedAt
    }
  }
  return {
    skills: [...rows.values()].map(({ row }) => row)
      .sort((a, b) => b.uses - a.uses || a.skill.localeCompare(b.skill)),
    skipped,
  }
}

/** UI-only viewport: opening/closing it never appends session content. */
export class SkillUsageDialog implements Component {
  private offset = 0
  private pageSize = 1
  private lineCount = 0
  private readonly document: Markdown

  constructor(private readonly tui: TUI, private readonly theme: Theme, report: string, private readonly done: () => void, private readonly title = 'Skill usage') {
    this.document = new Markdown(report, 0, 0, getMarkdownTheme())
  }

  invalidate(): void { this.document.invalidate() }

  render(width: number): string[] {
    if (width < 1) return []
    const bodyWidth = Math.max(1, width - 4)
    const content = this.document.render(bodyWidth)
    this.lineCount = content.length
    // Keep the footer visible on short terminals, including after a resize.
    // Fixed lines: 2 borders, footer.
    this.pageSize = dialogRows(this.tui, 3)
    this.offset = Math.max(0, Math.min(this.offset, this.lineCount - this.pageSize))
    const border = (text: string) => this.theme.fg('border', text)
    const row = (text: string) => {
      const fitted = truncateToWidth(text, bodyWidth, '…')
      return border('┃') + ` ${fitted}${' '.repeat(Math.max(0, bodyWidth - visibleWidth(fitted)))} ` + border('┃')
    }
    const title = truncateToWidth(` ${this.title} `, Math.max(0, width - 2), '…')
    const range = `${this.lineCount ? this.offset + 1 : 0}–${Math.min(this.offset + this.pageSize, this.lineCount)}/${this.lineCount}`
    const lines = [border(`┏${title}${'━'.repeat(Math.max(0, width - 2 - visibleWidth(title)))}┓`),
      ...Array.from({ length: this.pageSize }, (_, i) => row(content[this.offset + i] ?? '')),
      row(this.theme.fg('dim', `Esc close · ↑↓ scroll · PgUp/PgDn · ${range}`)),
      border(`┗${'━'.repeat(Math.max(0, width - 2))}┛`)]
    return lines.map((line) => truncateToWidth(line, width, ''))
  }

  handleMouse(event: TuiMouseEvent) { return wheelAsArrows(event, (key) => this.handleInput(key)) }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'enter')) return this.done()
    if (matchesKey(data, 'up')) this.offset--
    else if (matchesKey(data, 'down')) this.offset++
    else if (matchesKey(data, 'pageUp')) this.offset -= this.pageSize
    else if (matchesKey(data, 'pageDown')) this.offset += this.pageSize
    else if (matchesKey(data, 'home')) this.offset = 0
    else if (matchesKey(data, 'end')) this.offset = this.lineCount
    else return
    this.offset = Math.max(0, Math.min(this.offset, this.lineCount - this.pageSize))
    this.tui.requestRender()
  }
}

export default function register(pi: ExtensionAPI): void {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const logPath = join(agentDir.replace(/^~(?=$|[\\/])/, homedir()), 'skill-usage.log')
  let currentSid: string | undefined
  let currentCwd = ''
  let tracker: SkillTracker
  let logError: string | undefined
  let warned = false

  function forSession(ctx: ExtensionContext): SkillTracker {
    const sid = ctx.sessionManager.getSessionId()
    currentCwd = ctx.cwd
    if (sid !== currentSid || !tracker) {
      currentSid = sid
      warned = false
      logError = undefined
      tracker = buildTracker((e) => {
        try {
          mkdirSync(dirname(logPath), { recursive: true })
          const fields = [localTimestamp(), sid, currentCwd, e.event, e.skill, normalize(e.path), e.model ?? 'unknown', e.thinking ?? 'unknown']
          // Keep unusual filenames and working directories from corrupting TSV rows.
          appendFileSync(logPath, fields.map(logField).join('\t') + '\n')
        } catch (error) {
          logError = error instanceof Error ? error.message : String(error)
        }
      })
    }
    return tracker
  }

  pi.on('session_start', (_event, ctx) => { forSession(ctx) })
  pi.on('before_agent_start', (_event, ctx) => { forSession(ctx).handleRequestStart() })
  pi.on('tool_call', (event, ctx) => { forSession(ctx).handleToolCall(event.toolName, agentMetadata(pi, ctx)) })
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName !== 'read' || event.isError || typeof event.input.path !== 'string') return
    const raw = event.input.path.replace(/^~(?=$|[\\/])/, homedir())
    forSession(ctx).handleSkillRead(resolve(ctx.cwd, raw), agentMetadata(pi, ctx))
  })
  pi.on('turn_end', (_event, ctx) => {
    forSession(ctx).handleTurnEnd()
    if (logError && !warned && ctx.hasUI) {
      warned = true
      ctx.ui.notify(`Skill usage could not be logged to ${logPath}: ${logError}`, 'warning')
    }
  })

  pi.registerCommand('skill-usage', {
    description: 'List historical skill usage, agent models, thinking levels and local last-used times',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('Skill usage requires interactive terminal mode; no report was added to the transcript.', 'info')
        return
      }
      if (args.trim()) {
        ctx.ui.notify('Usage: /skill-usage (all logged sessions and projects)', 'info')
        return
      }
      try {
        let log = ''
        try {
          log = await readFile(logPath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const installed = pi.getCommands().filter((command) => command.source === 'skill').map((command) => command.name.replace(/^skill:/, ''))
        const { skills, skipped } = summarizeUsage(log, installed)
        const time = usageTimeFormat()
        const lines = ['Skill usage — all logged sessions and projects', '',
          'Counts are unique sessions, not tool calls. Used = read followed by tool activity in the same request.',
          'Older entries used a same-model-turn rule and may undercount. Every installed skill is listed; 0 / never = not used since logging began.', '',
          `| Skill | Loaded sessions | Used sessions | Last used (${markdownCell(time.label)}) |`,
          '| --- | ---: | ---: | --- |']
        for (const row of skills) {
          lines.push(`| ${markdownCell(row.skill)} | ${row.loads} | ${row.uses} | ${row.lastUsed ? markdownCell(time.format(new Date(row.lastUsed))) : 'never'} |`)
        }
        if (skills.some((row) => row.loads)) {
          lines.push('', 'By selected agent model and thinking level (unique sessions within each group; groups may overlap):',
            'Legacy metadata is unknown. Only the first load/use per session is logged; this is not every model that later used the skill.', '',
            '| Skill | Model | Thinking | Loaded sessions | Used sessions |',
            '| --- | --- | --- | ---: | ---: |')
          for (const row of summarizeLog(log, true).skills) {
            lines.push(`| ${markdownCell(row.skill)} | ${markdownCell(row.model!)} | ${markdownCell(row.thinking!)} | ${row.loads} | ${row.uses} |`)
          }
        }
        if (!skills.some((row) => row.loads)) lines.push('', 'No skill usage recorded yet.')
        if (skipped) lines.push('', `Skipped ${skipped} malformed log row(s).`)
        lines.push('', `Log: ${normalize(logPath).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`)
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
          new SkillUsageDialog(tui, theme, lines.join('\n'), done), DIALOG_OVERLAY)
      } catch (error) {
        ctx.ui.notify(`Could not show skill usage: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    },
  })
}
