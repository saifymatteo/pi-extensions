/**
 * Passive, forward-only tool usage log. Includes direct and nested executions,
 * but never arguments/results. Success means the tool returned, not that a
 * background command or delegated agent eventually succeeded.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SkillUsageDialog } from './skill-usage-log.ts'
import { DIALOG_OVERLAY } from './lib/dialog.ts'
import { agentMetadata, localTimestamp, logField, markdownCell, usageTimeFormat } from './lib/usage-log.ts'

export interface ToolUsageRecord {
  version: 1
  timestamp: string
  session: string
  cwd: string
  tool: string
  callId: string
  parentCallId?: string
  model: string
  thinking: string
  status: 'success' | 'error' | 'interrupted'
  durationMs: number
}

export interface ToolUsageRow {
  tool: string
  calls: number
  sessions: number
  errors: number
  nested: number
  durationMs: number
  /** null = installed but never called. */
  lastUsed: string | null
}

export interface ToolUsageBreakdown extends ToolUsageRow {
  model: string
  thinking: string
}

/** MCP tools (`mcp__<server>__<tool>`) report as one row per server, `mcp__<server>__*`; the log keeps full names. */
const toolGroup = (tool: string) => tool.match(/^(mcp__.+?__)./)?.[1].concat('*') ?? tool

/** Malformed/partial rows are ignored, not allowed to spoil the whole report.
 *  When supplied, `installed` filters removed tools and adds unseen tools as zero rows. */
export function summarizeToolUsage(log: string, installed?: string[]): {
  tools: ToolUsageRow[]; breakdown: ToolUsageBreakdown[]; skipped: number
} {
  const tools = new Map<string, { row: ToolUsageRow; sessions: Set<string> }>()
  const groups = new Map<string, { row: ToolUsageBreakdown; sessions: Set<string> }>()
  let skipped = 0
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: ToolUsageRecord
    try {
      const value = JSON.parse(line)
      if (!value || value.version !== 1 ||
          !['timestamp', 'session', 'cwd', 'tool', 'callId', 'model', 'thinking'].every(key => typeof value[key] === 'string') ||
          !value.session || !value.tool || !value.callId ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(value.timestamp) ||
          !Number.isFinite(Date.parse(value.timestamp)) ||
          (value.parentCallId !== undefined && typeof value.parentCallId !== 'string') ||
          !['success', 'error', 'interrupted'].includes(value.status) ||
          typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
        skipped++
        continue
      }
      record = value
    } catch {
      skipped++
      continue
    }
    const lastUsed = new Date(record.timestamp).toISOString()
    const name = toolGroup(record.tool)
    let entry = tools.get(name)
    if (!entry) {
      entry = { row: { tool: name, calls: 0, sessions: 0, errors: 0, nested: 0, durationMs: 0, lastUsed }, sessions: new Set() }
      tools.set(name, entry)
    }
    const key = JSON.stringify([name, record.model, record.thinking])
    let group = groups.get(key)
    if (!group) {
      group = { row: { ...entry.row, calls: 0, sessions: 0, errors: 0, nested: 0, durationMs: 0, lastUsed, model: record.model, thinking: record.thinking }, sessions: new Set() }
      groups.set(key, group)
    }
    for (const aggregate of [entry, group]) {
      aggregate.row.calls++
      aggregate.sessions.add(record.session)
      aggregate.row.sessions = aggregate.sessions.size
      if (record.status !== 'success') aggregate.row.errors++
      if (record.parentCallId) aggregate.row.nested++
      aggregate.row.durationMs += record.durationMs
      if (lastUsed > aggregate.row.lastUsed!) aggregate.row.lastUsed = lastUsed
    }
  }
  if (installed !== undefined) {
    const available = new Set(installed.map(toolGroup))
    for (const tool of tools.keys()) if (!available.has(tool)) tools.delete(tool)
    for (const [key, group] of groups) if (!available.has(group.row.tool)) groups.delete(key)
    for (const tool of available) {
      if (!tools.has(tool)) tools.set(tool, { row: { tool, calls: 0, sessions: 0, errors: 0, nested: 0, durationMs: 0, lastUsed: null }, sessions: new Set() })
    }
  }
  const sort = (a: ToolUsageRow, b: ToolUsageRow) => b.calls - a.calls || a.tool.localeCompare(b.tool)
  return {
    tools: [...tools.values()].map(({ row }) => row).sort(sort),
    breakdown: [...groups.values()].map(({ row }) => row).sort((a, b) => sort(a, b) || a.model.localeCompare(b.model) || a.thinking.localeCompare(b.thinking)),
    skipped,
  }
}

export default function register(pi: ExtensionAPI): void {
  const agentDir = (process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')).replace(/^~(?=$|[\\/])/, homedir())
  const logPath = join(agentDir, 'tool-usage.log')
  const pending = new Map<string, { record: Omit<ToolUsageRecord, 'status' | 'durationMs'>; start: number }>()
  let session: string | undefined
  let logError: string | undefined
  let warned = false

  function forSession(ctx: ExtensionContext): void {
    const sid = ctx.sessionManager.getSessionId()
    if (session === sid) return
    flushPending()
    warn(ctx)
    session = sid
    logError = undefined
    warned = false
  }

  function append(record: ToolUsageRecord): void {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, JSON.stringify(record) + '\n')
    } catch (error) {
      logError = error instanceof Error ? error.message : String(error)
    }
  }

  function flushPending(): void {
    for (const { record, start } of pending.values()) {
      append({ ...record, status: 'interrupted', durationMs: Math.max(0, Math.round(performance.now() - start)) })
    }
    pending.clear()
  }

  function warn(ctx: ExtensionContext): void {
    if (logError && !warned && ctx.hasUI) {
      warned = true
      try { ctx.ui.notify(`Tool usage could not be logged to ${logPath}: ${logError}`, 'warning') }
      catch { /* A closed UI must not turn a logging failure into a tool failure. */ }
    }
  }

  pi.on('session_start', (_event, ctx) => { forSession(ctx) })
  pi.on('tool_execution_start', (event, ctx) => {
    // Observation must never block a real tool, even if metadata is unavailable.
    try {
      forSession(ctx)
      pending.set(event.toolCallId, {
        start: performance.now(),
        record: {
          version: 1, timestamp: localTimestamp(), session: logField(session!),
          cwd: logField(ctx.cwd), tool: logField(event.toolName), callId: logField(event.toolCallId),
          ...(event.parentToolCallId ? { parentCallId: logField(event.parentToolCallId) } : {}),
          ...agentMetadata(pi, ctx),
        },
      })
    } catch (error) {
      logError = error instanceof Error ? error.message : String(error)
    }
  })
  pi.on('tool_execution_end', (event, ctx) => {
    const call = pending.get(event.toolCallId)
    if (!call) return // Started before reload, or already recorded.
    pending.delete(event.toolCallId)
    append({ ...call.record, status: event.isError ? 'error' : 'success', durationMs: Math.max(0, Math.round(performance.now() - call.start)) })
    warn(ctx)
  })
  pi.on('turn_end', (_event, ctx) => { warn(ctx) })
  pi.on('session_shutdown', (_event, ctx) => {
    flushPending()
    warn(ctx)
  })

  pi.registerCommand('tool-usage', {
    description: 'List historical tool calls, sessions, errors, model and thinking level',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('Tool usage requires interactive terminal mode; no report was added to the transcript.', 'info')
        return
      }
      if (args.trim()) {
        ctx.ui.notify('Usage: /tool-usage (all logged sessions and projects)', 'info')
        return
      }
      try {
        let log = ''
        try { log = await readFile(logPath, 'utf8') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const { tools, breakdown, skipped } = summarizeToolUsage(log, pi.getAllTools().map((tool) => tool.name))
        const time = usageTimeFormat()
        const lines = ['Tool usage — all logged sessions and projects', '',
          'Dates follow your locale. Different historical daylight-saving offsets are shown beside the date.',
          'Tracking starts when installed; no historical import. Every registered tool is listed; 0 / never = not called since then.',
          'MCP tools are grouped per server as mcp__<server>__*.',
          'Direct and nested calls are counted separately. Errors include interrupted calls; unfinished calls appear on orderly shutdown.',
          'Success means the tool returned, not that a background job succeeded. Duration includes hooks and nested work.', '',
          `| Tool | Calls | Sessions | Errors | Nested | Avg ms | Last used (${markdownCell(time.label)}) |`,
          '| --- | ---: | ---: | ---: | ---: | ---: | --- |']
        for (const row of tools) {
          lines.push(`| ${markdownCell(row.tool)} | ${row.calls} | ${row.sessions} | ${row.errors} | ${row.nested} | ${row.calls ? Math.round(row.durationMs / row.calls) : '—'} | ${row.lastUsed ? markdownCell(time.format(new Date(row.lastUsed))) : 'never'} |`)
        }
        if (!tools.some((row) => row.calls)) lines.push('', 'No tool usage recorded yet.')
        if (breakdown.length) {
          lines.push('', 'Agent model / thinking at call start (not a tool’s internal service model).', '',
            '| Tool | Model | Thinking | Calls | Sessions | Errors |',
            '| --- | --- | --- | ---: | ---: | ---: |')
          for (const row of breakdown) lines.push(`| ${markdownCell(row.tool)} | ${markdownCell(row.model)} | ${markdownCell(row.thinking)} | ${row.calls} | ${row.sessions} | ${row.errors} |`)
        }
        if (skipped) lines.push('', `Skipped ${skipped} malformed log row(s).`)
        lines.push('', `Log: ${markdownCell(logPath.replaceAll('\\', '/'))}`)
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
          new SkillUsageDialog(tui, theme, lines.join('\n'), done, 'Tool usage'), DIALOG_OVERLAY)
      } catch (error) {
        ctx.ui.notify(`Could not show tool usage: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    },
  })
}
