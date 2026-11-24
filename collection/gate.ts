/** Collection-only switch: skip packages listed in <agent-dir>/extensions/pi-extensions.json. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function disabledPackages(): Set<string> {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  let text: string
  try { text = readFileSync(join(agentDir, 'extensions', 'pi-extensions.json'), 'utf8') } catch { return new Set() }
  try {
    const disabled = JSON.parse(text)?.disabled
    return new Set(Array.isArray(disabled) ? disabled.filter(name => typeof name === 'string') : [])
  } catch (error) {
    // Fail open: a typo must not silently drop guards such as pi-root-guard.
    console.error(`pi-extensions.json ignored: ${(error as Error).message}`)
    return new Set()
  }
}

export function gate<T extends (...args: any[]) => unknown>(name: string, extension: T): T {
  return ((...args: unknown[]) => disabledPackages().has(name) ? undefined : extension(...args)) as T
}
