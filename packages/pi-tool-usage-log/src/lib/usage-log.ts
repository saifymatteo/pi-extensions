/** Shared metadata and local-time formatting for the two passive usage logs. */
export function userTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** An ISO timestamp with an explicit offset; DST and fractional-hour zones work. */
export function localTimestamp(date = new Date(), timeZone = userTimeZone()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date).map(({ type, value }) => [type, value]))
  const offset = parts.timeZoneName.replace('GMT', '') || '+00:00'
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3, '0')}${offset}`
}

/** Human-readable report dates; keep machine-readable log timestamps separate. */
export function usageTimeFormat(timeZone = userTimeZone(), locale?: string | string[], now = new Date()) {
  const formatter = new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'medium', timeStyle: 'short' })
  const offset = localTimestamp(now, timeZone).slice(-6)
  const location = timeZone.split('/').pop()!.replaceAll('_', ' ')
  return {
    label: `${location} · UTC${offset}`,
    format(date: Date): string {
      const text = formatter.format(date)
      const dateOffset = localTimestamp(date, timeZone).slice(-6)
      // A historical DST offset can differ from the current offset in the header.
      return dateOffset === offset ? text : `${text} (UTC${dateOffset})`
    },
  }
}

export interface AgentMetadata {
  model: string
  thinking: string
}

/** Read the selected agent settings, not a classifier/TTS model used by a tool. */
export function agentMetadata(
  pi: { getThinkingLevel(): string },
  ctx: { model?: { provider: string; id: string } },
): AgentMetadata {
  let model = 'unknown'
  let thinking = 'unknown'
  // Logging must not block tool_call if settings are unavailable during a switch.
  try {
    const selected = ctx.model
    if (selected) model = `${selected.provider}/${selected.id}`
  } catch { /* Keep unknown metadata; the tool must still execute. */ }
  try { thinking = pi.getThinkingLevel() || 'unknown' }
  catch { /* Older runtimes may not expose the thinking getter. */ }
  return { model, thinking }
}

/** Strip terminal controls as well as TSV separators from untrusted metadata. */
export function logField(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
}

export function markdownCell(value: string): string {
  return logField(value).replace(/[\\`*_[\]<>|]/g, '\\$&')
}
