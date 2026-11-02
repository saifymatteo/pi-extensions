// Data half of /model-go (port of rizal72/oc-models-pro): OpenCode Go plan credits and
// stencil.so intelligence, matched onto Pi's own model catalogue. No Pi imports, so it runs bare:
//   node pi/extensions/lib/model-go.ts --self-check        (offline: parsing, matching, sorting)
//   node pi/extensions/lib/model-go.ts --self-check --live (plus both live fetches)
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const GO_PROVIDER = 'opencode-go'
export const GO_PAGE = 'https://opencode.ai/v2/docs/console/go/'
export const CATALOG = 'https://catalog.stencil.so/models.json'
const CACHE_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'state', 'model-go')
const DAY_MS = 86_400_000
const SIX_HOURS_MS = 6 * 60 * 60 * 1000

// ---------- Go plan page ----------

export interface GoLimit { name: string; input?: number; limit?: number; base?: number }
export interface GoPlan { price: number; limits: GoLimit[] }
/** credit = monthly limit ÷ plan price; promo = limit ÷ struck-through base; peak = peak ÷ off-peak input. */
export interface Credits { credit: number; promo?: number; peak?: number }

const text = (html: string) => html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const money = (html: string): number | undefined => {
  const plain = text(html)
  if (/free/i.test(plain)) return 0
  const found = plain.match(/\$([\d.]+)/)
  return found ? Number(found[1]) : undefined
}

/** Server-rendered table: model | input | output | cache read | cache write | monthly limit. Repeats per plan; first wins. */
export function parseGoTable(html: string): GoLimit[] {
  const limits: GoLimit[] = []
  const seen = new Set<string>()
  for (const raw of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = raw.split(/<\/tr>/i)[0].match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? []
    if (cells.length < 6) continue
    const name = text(cells[0])
    if (!name || /^model$/i.test(name) || seen.has(name)) continue
    seen.add(name)
    const monthly = cells[5]
    const promoted = monthly.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)
    const struck = monthly.match(/<del[^>]*>([\s\S]*?)<\/del>/i)
    limits.push({ name, input: money(cells[1]), limit: money(promoted ? promoted[1] : monthly), base: struck ? money(struck[1]) : undefined })
  }
  return limits
}

export const parsePlanPrice = (html: string): number | undefined => {
  const found = text(html).match(/\$\s?([\d.]+)\s*\/\s*month/i)
  return found ? Number(found[1]) : undefined
}

/** "GLM-5.3-Flash", "glm-5.3-flash" and "DeepSeek V4.1 Flash (Peak)" meet here. */
export const goKey = (name: string) => name.replace(/\s*\((?:off-?peak|peak)\)\s*$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export function credits(plan: GoPlan): Map<string, Credits> {
  const grouped = new Map<string, GoLimit[]>()
  for (const row of plan.limits) grouped.set(goKey(row.name), [...(grouped.get(goKey(row.name)) ?? []), row])
  const out = new Map<string, Credits>()
  const r1 = (n: number) => Math.round(n * 10) / 10
  for (const [id, rows] of grouped) {
    const off = rows.find((r) => /off-?peak/i.test(r.name)) ?? rows[0]
    const peak = rows.find((r) => /\(peak\)/i.test(r.name))
    if (!off.limit || !plan.price) continue
    out.set(id, {
      credit: r1(off.limit / plan.price),
      ...(off.base ? { promo: r1(off.limit / off.base) } : {}),
      ...(peak?.input && off.input ? { peak: r1(peak.input / off.input) } : {}),
    })
  }
  return out
}

// ---------- stencil.so intelligence ----------

/** "DeepSeek V4.1 Flash 1017" and `deepseek-v4.1-flash` meet here: labels and snapshot stamps come off. */
export function benchKey(name: string): string {
  let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  for (let round = 0; round < 2; round++) {
    key = key.replace(/-(?:latest|contributor|free|preview|exp|thinking)$/g, '')
    key = key.replace(/-\d{4,6}$/, (stamp) => (key.length - stamp.length >= 4 ? '' : stamp))
  }
  return key.replace(/^-|-$/g, '')
}

export function buildBenchIndex(catalog: Record<string, any>): Map<string, number> {
  const index = new Map<string, number>()
  for (const provider of Object.values(catalog ?? {}))
    for (const [id, meta] of Object.entries((provider as any)?.models ?? {})) {
      const int = (meta as any)?.int
      const key = benchKey(String(id).split('/').pop() ?? '')
      if (typeof int === 'number' && key && !index.has(key)) index.set(key, int)
    }
  return index
}

// ---------- cached fetch ----------

async function cachedFetch<T>(file: string, maxAgeMs: number, load: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  const path = join(CACHE_DIR, file)
  let previous: { fetched: number; value: T } | undefined
  try { previous = JSON.parse(await readFile(path, 'utf8')) } catch {}
  if (previous && Date.now() - previous.fetched < maxAgeMs) return { value: previous.value }
  try {
    const value = await load()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path + '.tmp', JSON.stringify({ fetched: Date.now(), value }))
    await rename(path + '.tmp', path)
    return { value }
  } catch (error) {
    // A stale copy beats an empty column; the error is still reported.
    return { value: previous?.value, error: error instanceof Error ? error.message : String(error) }
  }
}

const get = async (url: string) => {
  const response = await fetch(url, { headers: { 'user-agent': 'pi-model-go' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response
}

export async function loadGoCredits(): Promise<{ credits?: Map<string, Credits>; error?: string }> {
  const { value, error } = await cachedFetch<GoPlan>('go-plan.json', DAY_MS, async () => {
    const html = await (await get(GO_PAGE)).text()
    const plan = { price: parsePlanPrice(html) ?? 0, limits: parseGoTable(html) }
    if (!plan.price || !plan.limits.length) throw new Error('Go page shape changed')
    return plan
  })
  return { credits: value ? credits(value) : undefined, error: error && `Go plan: ${error}` }
}

export async function loadBench(): Promise<{ bench?: Map<string, number>; error?: string }> {
  const { value, error } = await cachedFetch<Record<string, number>>('bench.json', SIX_HOURS_MS, async () => {
    const index = buildBenchIndex(await (await get(CATALOG)).json())
    if (!index.size) throw new Error('catalog shape changed')
    return Object.fromEntries(index)
  })
  return { bench: value ? new Map(Object.entries(value)) : undefined, error: error && `stencil: ${error}` }
}

// ---------- rows ----------

export interface Row {
  provider: string
  id: string
  name: string
  /** $/M tokens; undefined = unknown, not free. */
  input?: number
  output?: number
  context?: number
  int?: number
  /** Go plan multiplier; 1 off the Go plan. */
  credit: number
  promo?: number
  peak?: number
  hasAuth: boolean
}

export function toRow(model: { provider: string; id: string; name?: string; cost?: { input?: number; output?: number }; contextWindow?: number },
  hasAuth: boolean, goCredits?: Map<string, Credits>, bench?: Map<string, number>): Row {
  const name = model.name || model.id
  const plan = model.provider === GO_PROVIDER ? (goCredits?.get(goKey(name)) ?? goCredits?.get(goKey(model.id))) : undefined
  const int = bench?.get(benchKey(name)) ?? bench?.get(benchKey(model.id))
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined)
  return {
    provider: model.provider, id: model.id, name,
    input: num(model.cost?.input), output: num(model.cost?.output), context: num(model.contextWindow),
    ...(int !== undefined ? { int } : {}),
    credit: plan?.credit ?? 1,
    ...(plan?.promo ? { promo: plan.promo } : {}),
    ...(plan?.peak ? { peak: plan.peak } : {}),
    hasAuth,
  }
}

/** What the Go plan makes a request cost: list input price ÷ credit multiplier. */
export const effective = (row: Row) => (row.input === undefined ? undefined : row.input / (row.credit || 1))

export type SortKey = 'effective' | 'input' | 'output' | 'context' | 'int' | 'name'
export const SORTS: SortKey[] = ['effective', 'input', 'output', 'context', 'int', 'name']
const VALUE: Record<Exclude<SortKey, 'name'>, [(r: Row) => number | undefined, 1 | -1]> = {
  effective: [effective, 1],
  input: [(r) => r.input, 1],
  output: [(r) => r.output, 1],
  context: [(r) => r.context, -1],
  int: [(r) => r.int, -1],
}

/** Unknown figures sort last in either direction; ties fall back to name so the list never reshuffles. */
export function compare(key: SortKey, a: Row, b: Row): number {
  const byName = a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider)
  if (key === 'name') return byName
  const [value, sign] = VALUE[key]
  const left = value(a), right = value(b)
  if (left === undefined || right === undefined) return left === right ? byName : left === undefined ? 1 : -1
  return left === right ? byName : (left < right ? -1 : 1) * sign
}

export const matches = (row: Row, query: string) =>
  query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => `${row.provider}/${row.id} ${row.name}`.toLowerCase().includes(word))

// ---------- self-check ----------

if (process.argv[2] === '--self-check') {
  const check = (ok: boolean, message: string) => { if (!ok) throw new Error('self-check: ' + message) }
  const html = `<h2>Go $10/month</h2><table><tr><th>Model</th></tr>
    <tr><td>DeepSeek V4.1 Flash (Off-Peak)</td><td>$0.15</td><td>$0.60</td><td>$0.01</td><td>-</td><td><del>$20</del> <strong>$80</strong> 4x</td></tr>
    <tr><td>DeepSeek V4.1 Flash (Peak)</td><td>$0.30</td><td>$1.20</td><td>$0.02</td><td>-</td><td>$80</td></tr>
    <tr><td>GLM-5.3</td><td>$1.40</td><td>$4.40</td><td>$0.26</td><td>-</td><td>$15</td></tr>
    <tr><td>GLM-5.3</td><td>$9</td><td>$9</td><td>$9</td><td>-</td><td>$99</td></tr></table>`
  const plan = { price: parsePlanPrice(html)!, limits: parseGoTable(html) }
  check(plan.price === 10, 'plan price')
  check(plan.limits.length === 3, 'repeated plan table: first occurrence wins')
  const table = credits(plan)
  const ds = table.get('deepseek-v4-1-flash')
  check(ds?.credit === 8 && ds.promo === 4 && ds.peak === 2, 'DeepSeek credit/promo/peak: ' + JSON.stringify(ds))
  check(table.get('glm-5-3')?.credit === 1.5, 'GLM credit')
  check(benchKey('DeepSeek V4.1 Flash 1017') === 'deepseek-v4-1-flash', 'bench key strips stamp')
  check(benchKey('Muse Spark 1.3 Contributor') === benchKey('muse-spark-1.3'), 'bench key strips label')
  const bench = buildBenchIndex({ a: { models: { 'x/deepseek-v4.1-flash': { int: 40 } } } })
  const go = toRow({ provider: GO_PROVIDER, id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', cost: { input: 0.15, output: 0.6 }, contextWindow: 1e6 }, false, table, bench)
  check(go.credit === 8 && go.int === 40 && effective(go) === 0.15 / 8, 'Go row: ' + JSON.stringify(go))
  const other = toRow({ provider: 'deepseek', id: 'deepseek-v4.1-flash', cost: { input: 0.15 } }, true, table, bench)
  check(other.credit === 1, 'credits apply to opencode-go only')
  const unknown = toRow({ provider: 'p', id: 'mystery' }, true)
  const sorted = (k: SortKey) => [unknown, other, go].sort((a, b) => compare(k, a, b))
  check(sorted('effective')[0] === go && sorted('effective')[2] === unknown, 'effective: cheapest first, unknown last')
  check(sorted('int')[2] === unknown, 'int: missing score last')
  check(matches(go, 'opencode-go flash') && !matches(go, 'glm'), 'search')
  if (process.argv[3] !== '--live') console.log('self-check ok (offline)')
  else {
    const [g, b] = await Promise.all([loadGoCredits(), loadBench()])
    check(!!g.credits && g.credits.size >= 10, 'live Go plan: ' + (g.error ?? g.credits?.size))
    check(!!b.bench && b.bench.size >= 20, 'live stencil: ' + (b.error ?? b.bench?.size))
    console.log(`self-check ok (live): ${g.credits!.size} Go models credited, ${b.bench!.size} benchmarked`)
  }
}
