import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readdir, rename, rmdir, unlink, utimes } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const HEADER_BYTES = 64 * 1024
const MANIFEST_BYTES = 1024 * 1024
export type Family = { id: string; paths: string[]; latestActivity: number; protected: boolean; reasons: string[] }
export type ScanResult = { families: Family[]; candidates: Family[]; issues: string[]; aborted: boolean }
// Adapter must hold its cross-process lock for the entire awaited operation, and
// discover active sessions itself. A guard is required, and only true permits work.
export type Guard = (operation: 'trash' | 'restore' | 'purge', paths: readonly string[]) => Promise<boolean>
export type MutationOptions = { now?: number; guard: Guard }
export type Manifest = { version: 1; id: string; trashedAt: number; ready: boolean; files: { original: string; stored: string }[] }
export type TrashBatch = { manifest: Manifest; missing: string[] }
export const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const inside = (root: string, path: string) => { const r = relative(root, path); return r !== '' && !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`) }
const time = (now = Date.now()) => { if (!Number.isFinite(now) || now < 0) throw new Error('Invalid clock'); return now }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Check every component, not just the leaf. Missing suffixes are allowed only
// for creation; existing symlinks and non-directory ancestors are always errors.
async function safePath(path: string, missing = false) {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let cursor = root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i])
    try {
      const s = await lstat(cursor)
      if (s.isSymbolicLink() || (i < parts.length - 1 && !s.isDirectory())) throw new Error(`Unsafe path: ${cursor}`)
    } catch (error) { if (missing && absent(error)) return; throw error }
  }
}
async function exists(path: string) { try { await lstat(path); return true } catch (error) { if (absent(error)) return false; throw error } }
async function regular(path: string) {
  await safePath(path)
  const s = await lstat(path)
  if (!s.isFile()) throw new Error(`Not a regular file: ${path}`)
  return s
}
async function header(path: string) {
  const before = await regular(path)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const s = await handle.stat()
    if (!s.isFile() || before.ino !== s.ino || before.dev !== s.dev) throw new Error(`Changed file: ${path}`)
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const end = buffer.subarray(0, bytesRead).indexOf(10)
    if (end < 0 && (s.size >= HEADER_BYTES || bytesRead < s.size)) throw new Error('Session header exceeds limit')
    const h = JSON.parse(buffer.subarray(0, end < 0 ? bytesRead : end).toString('utf8'))
    const stamp = typeof h.timestamp === 'string' ? Date.parse(h.timestamp) : NaN
    if (h.type !== 'session' || typeof h.id !== 'string' || !h.id.trim() || !Number.isFinite(stamp) ||
      (h.parentSession != null && (typeof h.parentSession !== 'string' || !isAbsolute(h.parentSession)))) throw new Error(`Invalid session header: ${path}`)
    return { parent: h.parentSession == null ? undefined : resolve(h.parentSession), activity: Math.max(s.mtimeMs, stamp) }
  } finally { await handle.close() }
}

export class RetentionStore {
  readonly root: string
  readonly trashRoot: string
  constructor(root: string, trashRoot: string) {
    this.root = resolve(root)
    this.trashRoot = resolve(trashRoot)
    if (pathKey(this.root) === pathKey(this.trashRoot) || inside(this.root, this.trashRoot) || inside(this.trashRoot, this.root)) throw new Error('Session and trash roots must be disjoint')
  }
  private async roots() {
    await safePath(this.root)
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Session root is not a directory')
    await safePath(this.trashRoot, true)
    if (await exists(this.trashRoot) && !(await lstat(this.trashRoot)).isDirectory()) throw new Error('Trash root is not a directory')
  }
  private async allow(options: MutationOptions, operation: Parameters<Guard>[0], paths: string[]) {
    if (typeof options?.guard !== 'function' || await options.guard(operation, paths) !== true) throw new Error('Mutation guard refused')
    await this.roots()
  }

  async scan(options: { now?: number; protectedPaths?: readonly string[] } = {}): Promise<ScanResult> {
    const now = time(options.now)
    await this.roots()
    const nodes = new Map<string, Awaited<ReturnType<typeof header>>>()
    const issues: string[] = []
    const walk = async (dir: string) => {
      try {
        await safePath(dir)
        for (const item of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, item.name)
          if (item.isSymbolicLink()) { issues.push(`Symlink skipped; completeness unknown: ${path}`); continue }
          if (item.isDirectory()) await walk(path)
          else if (item.name.endsWith('.jsonl')) {
            try { nodes.set(path, await header(path)) } catch (error) { issues.push(`${path}: ${message(error)}`) }
          }
        }
      } catch (error) { issues.push(`${dir}: ${message(error)}`) }
    }
    await walk(this.root)
    const neighbors = new Map([...nodes.keys()].map(path => [path, new Set<string>()]))
    const byKey = new Map([...nodes.keys()].map(path => [pathKey(path), path]))
    const invalid = new Map<string, string>()
    for (const [path, node] of nodes) {
      if (!node.parent) continue
      const parent = byKey.get(pathKey(node.parent))
      if (!inside(this.root, node.parent) || !parent) invalid.set(path, 'Missing or outside-root parent')
      else { neighbors.get(path)!.add(parent); neighbors.get(parent)!.add(path) }
    }
    const protectedPaths = new Set((options.protectedPaths ?? []).map(pathKey))
    const seen = new Set<string>()
    const families: Family[] = []
    for (const start of nodes.keys()) {
      if (seen.has(start)) continue
      const paths: string[] = [], queue = [start]
      while (queue.length) {
        const path = queue.pop()!
        if (seen.has(path)) continue
        seen.add(path); paths.push(path)
        queue.push(...neighbors.get(path)!)
      }
      paths.sort()
      const reasons = new Set<string>()
      for (const path of paths) {
        if (invalid.has(path)) reasons.add(invalid.get(path)!)
        if (protectedPaths.has(pathKey(path))) reasons.add('Active/protected session')
      }
      // A connected parent graph is a tree iff it has exactly one parentless root.
      if (paths.filter(path => !nodes.get(path)!.parent).length !== 1) reasons.add('Cycle or incomplete tree')
      families.push({ id: paths[0], paths, latestActivity: paths.reduce((latest, path) => Math.max(latest, nodes.get(path)!.activity), -Infinity), protected: reasons.size > 0, reasons: [...reasons] })
    }
    // An unreadable header could refer to ANY known family. Never guess completeness.
    return { families, candidates: issues.length ? [] : families.filter(f => !f.protected && now - f.latestActivity > RETENTION_MS), issues, aborted: issues.length > 0 }
  }

  private batchPath(id: string) {
    if (!uuid.test(id)) throw new Error('Invalid batch id')
    return join(this.trashRoot, id)
  }
  private original(path: string) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':')) || !path.endsWith('.jsonl')) throw new Error('Invalid original path')
    const absolute = resolve(this.root, ...path.split('/'))
    if (!inside(this.root, absolute)) throw new Error('Original path escapes root')
    return absolute
  }
  private async load(id: string): Promise<TrashBatch> {
    await this.roots()
    const dir = this.batchPath(id)
    const path = join(dir, 'manifest.json')
    const stat = await regular(path)
    if (stat.size > MANIFEST_BYTES) throw new Error('Manifest too large')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let m: Manifest
    try { m = JSON.parse(await handle.readFile('utf8')) } finally { await handle.close() }
    if (!m || m.version !== 1 || m.id !== id || !Number.isFinite(m.trashedAt) || m.trashedAt < 0 || typeof m.ready !== 'boolean' || !Array.isArray(m.files) || !m.files.length) throw new Error('Invalid manifest')
    const originals = new Set<string>(), stored = new Set<string>(), missing: string[] = []
    for (const [i, file] of m.files.entries()) {
      if (!file || file.stored !== `${i}.jsonl`) throw new Error('Invalid stored path')
      const original = this.original(file.original)
      if (originals.has(pathKey(original))) throw new Error('Duplicate original path')
      originals.add(pathKey(original)); stored.add(file.stored)
      await safePath(original, true)
      const target = join(dir, file.stored)
      if (!await exists(target)) missing.push(file.stored)
      else await regular(target)
    }
    // Never recursively remove a directory described by an untrusted manifest.
    for (const name of await readdir(dir)) {
      if (name === 'manifest.json' || stored.has(name)) continue
      if (/^manifest\.[0-9a-f-]+\.tmp$/.test(name) || [...stored].some(file => name === `${file}.staging`)) {
        await regular(join(dir, name))
        missing.push(name) // Crash debris forbids automatic purge, but not recovery.
      } else throw new Error(`Unexpected batch entry: ${name}`)
    }
    return { manifest: m, missing }
  }
  async listTrash(): Promise<{ batches: TrashBatch[]; issues: string[] }> {
    await this.roots()
    const batches: TrashBatch[] = [], issues: string[] = []
    if (!await exists(this.trashRoot)) return { batches, issues }
    for (const item of await readdir(this.trashRoot, { withFileTypes: true })) {
      // Shared store metadata belongs to the adapter, not to a session family.
      if (['settings.json', '.maintenance.lock'].includes(item.name) || /^settings-[0-9a-f-]+\.tmp$/.test(item.name)) continue
      try {
        if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('Not a batch directory')
        batches.push(await this.load(item.name))
      } catch (error) { issues.push(`${item.name}: ${message(error)}`) }
    }
    return { batches, issues }
  }
  // Atomic metadata replacement keeps the previous recoverable journal on crash.
  // Only metadata is renamed; session files are NEVER rename-overwritten.
  private async journal(manifest: Manifest, create = false) {
    const dir = this.batchPath(manifest.id), path = join(dir, 'manifest.json')
    await safePath(path, create)
    if (create) {
      const handle = await open(path, 'wx')
      try { await handle.writeFile(JSON.stringify(manifest)); await handle.sync() } finally { await handle.close() }
      return
    }
    await regular(path)
    const temp = join(dir, `manifest.${randomUUID()}.tmp`)
    const handle = await open(temp, 'wx')
    try { await handle.writeFile(JSON.stringify(manifest)); await handle.sync() } finally { await handle.close() }
    await regular(path)
    await rename(temp, path)
  }
  // Stage and sync the copy before exclusive hard-link publication on the target
  // filesystem. Even a crash mid-copy cannot expose a truncated recoverable file.
  // A crash after publication may leave BOTH copies: restore refuses that collision.
  private async move(source: string, target: string) {
    const before = await regular(source)
    await safePath(target, true)
    const staging = `${target}.staging`
    await copyFile(source, staging, constants.COPYFILE_EXCL)
    const handle = await open(staging, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try { await handle.sync() } finally { await handle.close() }
    await link(staging, target) // fails rather than overwriting any existing entry
    await unlink(staging)
    const after = await regular(source)
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed during move; both copies retained')
    await unlink(source)
  }
  async trashFamily(family: Family, options: MutationOptions): Promise<Manifest> {
    return (await this.trashFamilies([family], options))[0]
  }
  async trashFamilies(families: Family[], options: MutationOptions): Promise<Manifest[]> {
    const now = time(options?.now)
    await this.allow(options, 'trash', families.flatMap(f => f.paths))
    // Revalidate the entire plan once under the adapter's exclusive lock, not
    // once per family (which would reread O(n²) headers during the first cleanup).
    const scan = await this.scan({ now })
    const candidates = new Map(scan.candidates.map(f => [f.id, f]))
    const seen = new Set<string>()
    for (const family of families) {
      const current = candidates.get(family.id)
      if (!current || family.protected || seen.has(family.id) || current.paths.length !== family.paths.length || !current.paths.every((p, i) => p === family.paths[i])) throw new Error('Family is no longer a safe candidate')
      seen.add(family.id)
    }
    const manifests: Manifest[] = []
    for (const family of families) manifests.push(await this.trashValidated(family, { ...options, now }))
    return manifests
  }
  private async trashValidated(current: Family, options: MutationOptions): Promise<Manifest> {
    for (const path of current.paths) {
      if (time(options.now) - (await header(path)).activity <= RETENTION_MS) throw new Error('Family activity changed; no longer a safe candidate')
    }
    const manifest: Manifest = { version: 1, id: randomUUID(), trashedAt: time(options.now), ready: false, files: current.paths.map((path, i) => ({ original: relative(this.root, path).split(sep).join('/'), stored: `${i}.jsonl` })) }
    for (const file of manifest.files) this.original(file.original)
    if (Buffer.byteLength(JSON.stringify(manifest)) > MANIFEST_BYTES) throw new Error('Manifest too large')
    await mkdir(this.trashRoot, { recursive: true })
    await safePath(this.trashRoot)
    await mkdir(this.batchPath(manifest.id))
    await this.journal(manifest, true)
    for (const file of manifest.files) {
      await this.allow(options, 'trash', current.paths)
      const source = this.original(file.original)
      if (time(options.now) - (await header(source)).activity <= RETENTION_MS) throw new Error('Family activity changed; incomplete journal retained')
      await this.move(source, join(this.batchPath(manifest.id), file.stored))
    }
    await this.allow(options, 'trash', current.paths)
    manifest.ready = true
    await this.journal(manifest)
    return manifest
  }
  async restoreFamily(id: string, options: MutationOptions): Promise<{ restored: string[] }> {
    const now = time(options?.now)
    const { manifest } = await this.load(id)
    const paths = manifest.files.flatMap(file => [this.original(file.original), join(this.batchPath(id), file.stored)])
    await this.allow(options, 'restore', paths)
    // Preflight the whole batch before moving anything, including incomplete ones.
    for (const file of manifest.files) {
      const source = join(this.batchPath(id), file.stored), target = this.original(file.original)
      if (await exists(source) && await exists(target)) throw new Error(`Restore collision: ${target}`)
      if (!await exists(source) && !await exists(target)) throw new Error(`Missing both copies: ${target}`)
      if (await exists(target)) await regular(target)
    }
    manifest.ready = false
    await this.journal(manifest)
    const restored: string[] = []
    for (const file of manifest.files) {
      const source = join(this.batchPath(id), file.stored), target = this.original(file.original)
      await this.allow(options, 'restore', paths)
      await safePath(target, true)
      if (await exists(source)) {
        await mkdir(resolve(target, '..'), { recursive: true })
        await this.move(source, target)
        restored.push(target)
      }
      await regular(target)
      await utimes(target, new Date(now), new Date(now))
    }
    await this.allow(options, 'restore', paths)
    await this.removeJournal(id)
    return { restored }
  }
  private async removeJournal(id: string) {
    const dir = this.batchPath(id)
    await regular(join(dir, 'manifest.json'))
    const names = await readdir(dir)
    if (names.length !== 1 || names[0] !== 'manifest.json') throw new Error('Batch still contains files or crash debris; journal retained')
    await unlink(join(dir, 'manifest.json'))
    await rmdir(dir)
  }
  async purgeExpired(options: MutationOptions): Promise<{ purged: string[]; issues: string[] }> {
    const now = time(options?.now)
    await this.allow(options, 'purge', [])
    const { batches, issues } = await this.listTrash()
    const purged: string[] = []
    for (const batch of batches) {
      if (!batch.manifest.ready || batch.missing.length || now - batch.manifest.trashedAt <= RETENTION_MS) continue
      const id = batch.manifest.id
      try {
        const { manifest, missing } = await this.load(id)
        if (!manifest.ready || missing.length || now - manifest.trashedAt <= RETENTION_MS) continue
        const paths = manifest.files.flatMap(file => [this.original(file.original), join(this.batchPath(id), file.stored)])
        await this.allow(options, 'purge', paths)
        manifest.ready = false // A partial purge must never automatically continue.
        await this.journal(manifest)
        for (const file of manifest.files) {
          await this.allow(options, 'purge', paths)
          const path = join(this.batchPath(id), file.stored)
          await regular(path)
          await unlink(path)
        }
        await this.removeJournal(id)
        purged.push(id)
      } catch (error) { issues.push(`${id}: ${message(error)}`) }
    }
    return { purged, issues }
  }
}
