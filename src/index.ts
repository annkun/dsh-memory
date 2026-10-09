/**
 * Claude Code-style persistent memory for DeepSeek Harness.
 *
 * Registers four model-facing tools — memory_save, memory_search,
 * memory_read, memory_list — backed by plain files: one markdown file per
 * memory plus a MEMORY.md index, following the memory architecture Claude
 * Code popularized:
 *
 *   1. MEMORY.md acts as a compact, always-readable index.
 *   2. The index is guarded (200 lines / 25 KB) so memory can never silently
 *      eat the context window; oldest entries fall off the index first.
 *   3. Tool descriptions carry proactive-save guidance, so the model saves
 *      important facts (user preferences, project decisions, key numbers)
 *      without being asked — the behavioral half of "auto memory".
 *   3b. Since v0.2.0 the plugin also injects the memory index into the host
 *      system prompt (ctx.systemPrompt), so every session starts with its
 *      memories already loaded — the Claude Code "wake up with memory"
 *      behavior, not a hope-that-the-model-asks behavior.
 *   4. Storage is pure files: no external server, no embedding provider,
 *      nothing to provision. Search is case-insensitive substring matching,
 *      which is deterministic and dependency-free by design.
 *
 * Storage layout (v3.0 hierarchical; user dir configurable via
 * DSH_MEMORY_USER_DIR, default $DSH_HOME/memory or ~/.dsh/memory;
 * project dir auto-detected at <git-root>/.dsh/memory):
 *
 *   ~/.dsh/memory/MEMORY.md                user index, newest first
 *   ~/.dsh/memory/memories/<date>-<slug>.md one file per user memory
 *   <git-root>/.dsh/memory/MEMORY.md        project index (git-shared)
 *   <git-root>/.dsh/memory/memories/*.md    one file per project memory
 *
 * @module dsh-memory
 */

import { promises as fs, existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plugin name registered with the Loader. */
export const name = 'dsh-memory'

/** Host services this plugin consumes. Cordis enforces inject: accessing
 * ctx.systemPrompt without declaring it throws "cannot get property without
 * inject" and the whole plugin fails to activate (found via real DSH host
 * debugging; official tool-fs declares ['tools', 'fs', 'systemPrompt']). */
export const inject = ['tools', 'systemPrompt']

/* ------------------------------------------------------------------ *
 * Guards — the Claude Code memory lesson: an index without a cap is  *
 * a slow leak into the context window.                               *
 * ------------------------------------------------------------------ */

const MAX_INDEX_LINES = 200
const MAX_INDEX_BYTES = 25 * 1024
const MAX_MEMORIES = 500
const DEFAULT_SEARCH_LIMIT = 8
const MAX_CONTENT_CHARS = 20_000

/* v3.0 hierarchical scopes:
 *   user    ~/.dsh/memory            cross-project preferences and personal facts
 *   project <git-root>/.dsh/memory   team-shared decisions, committed to git
 * The active project scope is detected from the process cwd by walking up to
 * the nearest .git directory; when absent, only the user scope is used. */
const USER_DIR = process.env.DSH_MEMORY_USER_DIR
  ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'memory')

const MAX_WALK_LEVELS = 8
const MARKER_DIR = path.join('.dsh', 'memory')
const VCS_MARKERS = ['.git', '.svn', '.hg'] as const

export interface ProjectResolution { dir?: string, source: 'env' | 'walk' | 'cwd' | 'none' }

/**
 * v0.4 project-scope detection chain. Priority = explicitness, most explicit
 * first; a fused upward walk implements levels 2-3 (own marker beats a VCS
 * root at the same level, anything at a lower level beats anything higher):
 *
 *   1. DSH_MEMORY_PROJECT_DIR env override (user's explicit intent)
 *   2. an existing .dsh/memory marker above (our own past anchor — supports
 *      intentional nested sub-project scopes)
 *   3. a VCS root (.git / .svn / .hg) above (filesystem's project boundary;
 *      anchors SVN/Hg projects correctly on first use)
 *   4. cwd itself (workspace-scoped fallback for VCS-less projects)
 *
 * Guard: $HOME, /, /tmp and /private/tmp never become a project scope —
 * a dotfiles ~/.git must not turn home into one giant shared bucket, and
 * /tmp memories would silently vanish on reboot. When the guard fires the
 * result is "no project scope" (better no isolation than wrong isolation).
 * The host workspaceRegistry refinement runs separately in apply() because
 * it is an async host service.
 */
export function resolveProjectScope(startDir: string = process.cwd(), opts: { homeDir?: string } = {}): ProjectResolution {
  const home = path.resolve(opts.homeDir ?? os.homedir())
  const guarded = (d: string): boolean => {
    const r = path.resolve(d)
    return r === home || r === '/' || r === '/tmp' || r === '/private/tmp'
  }
  const envDir = process.env.DSH_MEMORY_PROJECT_DIR
  if (envDir !== undefined && envDir.trim() !== '' && path.isAbsolute(envDir) && !guarded(envDir)) {
    return { dir: path.join(path.resolve(envDir), MARKER_DIR), source: 'env' }
  }
  let cur = path.resolve(startDir)
  for (let i = 0; i < MAX_WALK_LEVELS; i++) {
    if (guarded(cur)) break // never inspect or cross a guarded directory
    if (existsSync(path.join(cur, MARKER_DIR))) return { dir: path.join(cur, MARKER_DIR), source: 'walk' }
    if (VCS_MARKERS.some(m => existsSync(path.join(cur, m)))) return { dir: path.join(cur, MARKER_DIR), source: 'walk' }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  const start = path.resolve(startDir)
  return guarded(start) ? { source: 'none' } : { dir: path.join(start, MARKER_DIR), source: 'cwd' }
}

function scopeDir(scope: 'user' | 'project'): string | undefined {
  if (scope === 'user') return USER_DIR
  return PROJECT_DIR
}

const initialResolution = resolveProjectScope()
let PROJECT_DIR: string | undefined = initialResolution.dir
let projectDirSource: 'env' | 'walk' | 'cwd' | 'none' | 'workspace' = initialResolution.source

function activeScopes(): Array<'user' | 'project'> {
  return PROJECT_DIR === undefined ? ['user'] : ['user', 'project']
}

/**
 * Async level 3.5: when the sync chain had to fall back to cwd (no marker,
 * no VCS), the host workspace registry may still know the real project root
 * the user registered. Best-effort and fully optional — unknown shapes or
 * failures keep the cwd-fallback scope. Runs inside apply() before any tool
 * can execute, so the upgrade lands before the first save anchors a marker
 * in the wrong place.
 */
async function refineWithWorkspaceRegistry(ctx: Context): Promise<void> {
  if (projectDirSource !== 'cwd') return
  const registry = (ctx as unknown as { workspaceRegistry?: { list(): Promise<unknown[]> } }).workspaceRegistry
  if (registry === undefined || typeof registry.list !== 'function') return
  try {
    const entries = await registry.list()
    const cwd = process.cwd()
    let best: string | undefined
    for (const entry of entries) {
      const e = entry as Record<string, unknown>
      const raw = typeof e.directory === 'function' ? String(e.directory()) : e.directory
      if (typeof raw !== 'string' || !path.isAbsolute(raw)) continue
      const root = path.resolve(raw)
      const rel = path.relative(root, cwd)
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        if (best === undefined || root.length > best.length) best = root // deepest ancestor wins
      }
    }
    if (best !== undefined) {
      const home = path.resolve(os.homedir())
      const r = path.resolve(best)
      const isGuarded = r === home || r === '/' || r === '/tmp' || r === '/private/tmp'
      if (!isGuarded) {
        PROJECT_DIR = path.join(best, MARKER_DIR)
        projectDirSource = 'workspace'
      }
    }
  } catch {
    // registry unavailable or shape unknown: keep the cwd-fallback scope
  }
}
const memoryDirOf = (base: string) => path.join(base, 'memories')
const indexFileOf = (base: string) => path.join(base, 'MEMORY.md')
const INDEX_HEADER = '# Memory Index (newest first; auto-truncated to 200 lines / 25 KB)\n'

/* ------------------------------------------------------------------ *
 * Storage helpers                                                     *
 * ------------------------------------------------------------------ */

function timestamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'memory'
}

/** Slice that never splits a UTF-16 surrogate pair (an emoji would render as \ufffd). */
function safeSlice(s: string, n: number): string {
  const cut = s.slice(0, n)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xD800 && last <= 0xDBFF ? cut.slice(0, -1) : cut
}

/** Full-width brackets in free text, so index-line links and the date-anchored path-tag parser stay unambiguous. */
const indexSafe = (s: string) => s.replace(/\[/g, '\uff3b').replace(/\]/g, '\uff3d')

async function ensureDirs(base: string): Promise<void> {
  await fs.mkdir(memoryDirOf(base), { recursive: true })
}

/** Parse index body lines, self-healing orphans: a line whose memory file no
 * longer exists (pruned or hand-deleted) drops out of every read path; the
 * next save rewrites the index without it. Unparseable lines are kept — never
 * auto-delete what we cannot parse. */
function parseIndexLines(text: string, base: string): string[] {
  const dir = memoryDirOf(base)
  return text.split('\n').filter(line => {
    if (!line.startsWith('- ')) return false
    const m = /\(memories\/([^)]+\.md)\)/.exec(line)
    if (m === null) return true // no recognizable link — keep
    return existsSync(path.join(dir, m[1]!))
  })
}

async function readIndex(base: string): Promise<string[]> {
  try {
    const text = await fs.readFile(indexFileOf(base), 'utf8')
    return parseIndexLines(text, base)
  } catch {
    return []
  }
}

/** Write one scope's index with both guards applied; returns the kept line count. */
async function writeIndexGuarded(base: string, lines: string[]): Promise<number> {
  let kept = lines.slice(0, MAX_INDEX_LINES)
  while (Buffer.byteLength(kept.join('\n'), 'utf8') > MAX_INDEX_BYTES && kept.length > 1) { // bytes, not chars: CJK is 3 bytes/char
    kept = kept.slice(0, kept.length - 1) // drop oldest (last) entries
  }
  await ensureDirs(base)
  // Atomic on disk (P0): write a sibling tmp file, then rename over the target,
  // so a crash mid-write can never leave a half-written MEMORY.md — the
  // prerequisite for a concurrent visual editor. This guarantees file
  // integrity, not last-writer-wins semantics: the read-modify-write race
  // (lost update) is deliberately left to the P2 optimistic lock. On Windows
  // a transiently-open target can fail the rename with EPERM; retry once.
  const target = indexFileOf(base)
  // unique tmp suffix: concurrent writers must never share a tmp path (a shared
  // name lets one writer's cleanup delete another's staged file mid-rename)
  const tmp = `${target}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`
  await fs.writeFile(tmp, INDEX_HEADER + kept.join('\n') + '\n', 'utf8')
  try {
    await fs.rename(tmp, target)
  } catch {
    await new Promise(resolve => setTimeout(resolve, 50)) // Windows EPERM: target briefly open
    await fs.rename(tmp, target)
  }
  return kept.length
}

/** Keep at most MAX_MEMORIES memory files per scope; prune oldest (by name sort). */
async function pruneMemories(base: string): Promise<number> {
  const dir = memoryDirOf(base)
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.md')).sort()
  const excess = files.length - MAX_MEMORIES
  for (let i = 0; i < excess; i++) {
    await fs.rm(path.join(dir, files[i]!), { force: true })
  }
  return Math.max(excess, 0)
}

/**
 * Atomic file write (P0 pattern, now shared): sibling tmp + rename, so a crash
 * mid-write can never leave a half-written file. Windows rename over a
 * transiently-open target can EPERM — retried with a short backoff, and the
 * tmp is always cleaned on terminal failure.
 */
async function atomicWriteFile(file: string, data: string): Promise<void> {
  const tmp = `${file}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`
  await fs.writeFile(tmp, data, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (e) {
      const code = String((e as NodeJS.ErrnoException).code ?? '')
      if (attempt >= 2 || (code !== 'EPERM' && code !== 'EACCES')) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

interface SaveCoreInput {
  scope: 'user' | 'project'
  base: string
  title: string
  content: string
  tags?: string[]
  memPathArg?: string
  /** v0.11: the calling session's working directory (write side of session scoping). */
  sessionCwd?: string
}

type SaveCoreResult =
  | { ok: true, saved: true, id: string, scope: string, file: string, updated: boolean, indexEntries: number, prunedMemories: number, notice: string }
  | { ok: false, error: string }

/**
 * Shared save core (P2): the model tool and the panel POST write through the
 * exact same path — dedupe-and-update, guard caps, atomic writes. The base
 * directory is supplied by the caller, so the panel can target any known
 * workspace while the tool keeps using the detected scopes.
 */
async function saveMemoryCore(input: SaveCoreInput): Promise<SaveCoreResult> {
  const { scope, base, title, content } = input
  try {
    const now = new Date()
    const slug = slugify(title)
    const date = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
    await ensureDirs(base)
    const dir = memoryDirOf(base)
    // Claude-Code write rule — dedupe-and-update: same title slug updates in
    // place instead of appending a near-duplicate.
    const existing = (await fs.readdir(dir).catch(() => [] as string[])).find(f => f.endsWith(`-${slug}.md`))
    const id = existing === undefined ? `${timestamp(now)}-${slug}` : existing.replace(/\.md$/, '')
    const updated = existing !== undefined
    const file = path.join(dir, `${id}.md`)
    let memPath = (input.memPathArg?.trim() ?? '').replace(/[^a-zA-Z0-9\u4e00-\u9fff/_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (memPath === '' && scope === 'project') {
      // v0.11: the path tag follows the CALLING SESSION's cwd when known (the
      // tool passes exec.agent's header cwd; the panel has none and keeps the
      // process default). projRoot derives from the target base itself, so a
      // session-scoped save tags against ITS workspace, not the service anchor.
      const projRoot = path.resolve(base, '..', '..') // base = <root>/.dsh/memory
      const cwd = input.sessionCwd ?? process.cwd()
      if (cwd.startsWith(projRoot + path.sep)) memPath = path.relative(projRoot, cwd).split(path.sep).join('/')
    }
    const header = `---\nid: ${id}\nscope: ${scope}\npath: ${memPath}\nsaved_at: ${now.toISOString()}\ntags: ${(input.tags ?? []).join(', ')}\n---\n\n# ${title}\n\n`
    await atomicWriteFile(file, header + content + '\n')
    const tagSuffix = input.tags?.length ? ` \`${input.tags.join('` `')}\`` : ''
    const pathTag = memPath !== '' ? ` [${memPath}]` : ''
    const indexLine = `- [${indexSafe(title)}](memories/${id}.md) — ${indexSafe(safeSlice(content.split('\n')[0] ?? '', 80))} (${date})${pathTag}${tagSuffix}`
    const lines = (await readIndex(base)).filter(l => !l.includes(`(memories/${id}.md)`))
    lines.unshift(indexLine)
    const kept = await writeIndexGuarded(base, lines)
    const pruned = updated ? 0 : await pruneMemories(base)
    return {
      ok: true, saved: true, id, scope, file, updated, indexEntries: kept, prunedMemories: pruned,
      notice: `${updated ? `Updated existing ${scope} memory ${id}` : `Saved 1 ${scope} memory`} (${scope === 'project' ? 'team-shared, commit it to git' : 'personal, cross-project'}). Index now lists ${kept} entries.`,
    }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

/**
 * Record the active project root in the user-scope workspace ledger so the
 * panel can enumerate workspaces without any host service. Best-effort and
 * silent: a failed ledger write never blocks activation.
 */
async function recordWorkspace(): Promise<void> {
  if (PROJECT_DIR === undefined || projectDirSource === 'cwd') return // cwd fallback is not a durable project boundary — never ledger it
  const root = path.resolve(PROJECT_DIR, '..', '..')
  const file = path.join(USER_DIR, 'workspaces.json')
  let parsed: unknown = []
  try { parsed = JSON.parse(readFileSync(file, 'utf8')).workspaces } catch { /* absent/corrupt → fresh */ }
  const list = (Array.isArray(parsed) ? parsed : []).filter((w): w is string => typeof w === 'string' && path.isAbsolute(w))
  if (list.includes(root)) return
  list.unshift(root)
  await atomicWriteFile(file, JSON.stringify({ workspaces: list.slice(0, 50) }, null, 2) + '\n').catch(() => {})
}

/**
 * Every workspace the panel may show or write: the host workspace registry
 * (authoritative, when the service exists) union the user-scope ledger
 * (self-contained fallback). Both best-effort; unknown shapes are skipped.
 */
async function knownWorkspaces(ctx: Context): Promise<string[]> {
  const roots = new Set<string>()
  try {
    const registry = (ctx as unknown as { workspaceRegistry?: { list(): Promise<unknown[]> } }).workspaceRegistry
    if (registry !== undefined && typeof registry.list === 'function') {
      for (const entry of await registry.list()) {
        const e = entry as Record<string, unknown>
        const raw = typeof e.directory === 'function' ? String(e.directory()) : e.directory
        if (typeof raw === 'string' && path.isAbsolute(raw)) roots.add(path.resolve(raw))
      }
    }
  } catch { /* best-effort */ }
  try {
    const ledger = JSON.parse(readFileSync(path.join(USER_DIR, 'workspaces.json'), 'utf8')).workspaces
    for (const w of Array.isArray(ledger) ? ledger : []) {
      if (typeof w === 'string' && path.isAbsolute(w)) roots.add(path.resolve(w))
    }
  } catch { /* absent → skip */ }
  return [...roots]
}

/**
 * Panel save endpoint (P2): { scope, workspace?, title, content, tags? }.
 * A project save may target any KNOWN workspace (registry or ledger) — an
 * arbitrary path is rejected, so the browser can never use this API as a
 * general-purpose file writer.
 */
async function handlePanelSave(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > 1_000_000) { reply(413, { ok: false, error: 'body too large' }); return }
      chunks.push(chunk as Buffer)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { scope?: unknown, workspace?: unknown, title?: unknown, content?: unknown, tags?: unknown }
    const title = safeSlice(String(body.title ?? '').trim(), 60)
    const content = safeSlice(String(body.content ?? '').trim(), MAX_CONTENT_CHARS)
    const tags = (Array.isArray(body.tags) ? body.tags : []).filter((t): t is string => typeof t === 'string').slice(0, 10)
    if (title === '' || content === '') { reply(400, { ok: false, error: 'title and content must be non-empty' }); return }
    let base: string | undefined
    if (body.scope === 'user') {
      base = scopeDir('user')
    } else if (body.scope === 'project') {
      if (body.workspace !== undefined) {
        const root = path.resolve(String(body.workspace))
        if (!(await knownWorkspaces(ctx)).includes(root)) { reply(400, { ok: false, error: 'unknown workspace' }); return }
        base = path.join(root, '.dsh', 'memory')
      } else {
        base = PROJECT_DIR
      }
    } else {
      reply(400, { ok: false, error: 'scope must be "user" or "project"' }); return
    }
    if (base === undefined) { reply(400, { ok: false, error: 'target scope unavailable' }); return }
    const r = await saveMemoryCore({ scope: body.scope, base, title, content, tags })
    if (!r.ok) { reply(500, { ok: false, error: r.error }); return }
    reply(200, r)
  } catch (e) {
    reply(400, { ok: false, error: String((e as Error)?.message ?? e) })
  }
}

/**
 * Panel delete endpoint (P2.1): { scope, workspace?, id }. Deletes one memory
 * file and drops its index line. The id is validated against a strict slug
 * charset (no separators, no dots) so the browser can never traverse paths;
 * the workspace guard mirrors the save endpoint.
 */
async function handlePanelDelete(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
  try {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(chunk as Buffer)
      if (chunks.reduce((n, c) => n + c.length, 0) > 10_000) { reply(413, { ok: false, error: 'body too large' }); return }
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { scope?: unknown, workspace?: unknown, id?: unknown }
    const id = String(body.id ?? '').replace(/\.md$/, '')
    if (!/^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(id)) { reply(400, { ok: false, error: 'invalid id' }); return }
    let base: string | undefined
    if (body.scope === 'user') {
      base = scopeDir('user')
    } else if (body.scope === 'project') {
      if (body.workspace !== undefined) {
        const root = path.resolve(String(body.workspace))
        if (!(await knownWorkspaces(ctx)).includes(root)) { reply(400, { ok: false, error: 'unknown workspace' }); return }
        base = path.join(root, '.dsh', 'memory')
      } else {
        base = PROJECT_DIR
      }
    } else {
      reply(400, { ok: false, error: 'scope must be "user" or "project"' }); return
    }
    if (base === undefined) { reply(400, { ok: false, error: 'target scope unavailable' }); return }
    const file = path.join(memoryDirOf(base), `${id}.md`)
    if (!existsSync(file)) { reply(404, { ok: false, error: 'memory not found' }); return }
    await fs.rm(file, { force: true })
    const lines = (await readIndex(base)).filter(l => !l.includes(`(memories/${id}.md)`))
    const kept = await writeIndexGuarded(base, lines)
    reply(200, { ok: true, deleted: id, indexEntries: kept })
  } catch (e) {
    reply(400, { ok: false, error: String((e as Error)?.message ?? e) })
  }
}

/**
 * Panel update endpoint (P2.2): { scope, workspace?, id, title?, content?, tags? }.
 * Rewrites one memory in place — same file (stable id), refreshed saved_at,
 * rebuilt index line. Only the given fields change; path tag and file name stay.
 */
async function handlePanelUpdate(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
  try {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(chunk as Buffer)
      if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) { reply(413, { ok: false, error: 'body too large' }); return }
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { scope?: unknown, workspace?: unknown, id?: unknown, title?: unknown, content?: unknown, tags?: unknown }
    const rawId = String(body.id ?? '').replace(/\.md$/, '')
    if (!/^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(rawId)) { reply(400, { ok: false, error: 'invalid id' }); return }
    const title = body.title === undefined ? undefined : safeSlice(String(body.title).trim(), 60)
    const content = body.content === undefined ? undefined : safeSlice(String(body.content).trim(), MAX_CONTENT_CHARS)
    const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : undefined
    if (title === '') { reply(400, { ok: false, error: 'title must be non-empty' }); return }
    if (content === '') { reply(400, { ok: false, error: 'content must be non-empty' }); return }
    let base: string | undefined
    if (body.scope === 'user') {
      base = scopeDir('user')
    } else if (body.scope === 'project') {
      if (body.workspace !== undefined) {
        const root = path.resolve(String(body.workspace))
        if (!(await knownWorkspaces(ctx)).includes(root)) { reply(400, { ok: false, error: 'unknown workspace' }); return }
        base = path.join(root, '.dsh', 'memory')
      } else {
        base = PROJECT_DIR
      }
    } else {
      reply(400, { ok: false, error: 'scope must be "user" or "project"' }); return
    }
    if (base === undefined) { reply(400, { ok: false, error: 'target scope unavailable' }); return }
    const file = path.join(memoryDirOf(base), `${rawId}.md`)
    if (!existsSync(file)) { reply(404, { ok: false, error: 'memory not found' }); return }
    const text = await fs.readFile(file, 'utf8')
    const fm = /^---\n([\s\S]*?)\n---\n\n# (.*)\n\n([\s\S]*)$/.exec(text)
    if (fm === null) { reply(422, { ok: false, error: 'unrecognized memory file format' }); return }
    const oldPath = /^path: (.*)$/m.exec(fm[1]!)?.[1] ?? ''
    const oldScope = /^scope: (.*)$/m.exec(fm[1]!)?.[1] ?? String(body.scope)
    const newTitle = title ?? fm[2]!
    const newContent = content ?? fm[3]!
    const newTags = tags ?? (/^tags: (.*)$/m.exec(fm[1]!)?.[1] ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
    const now = new Date()
    const date = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
    const header = `---\nid: ${rawId}\nscope: ${oldScope}\npath: ${oldPath}\nsaved_at: ${now.toISOString()}\ntags: ${newTags.join(', ')}\n---\n\n# ${newTitle}\n\n`
    await atomicWriteFile(file, header + newContent + '\n')
    const tagSuffix = newTags.length ? ` \`${newTags.join('` `')}\`` : ''
    const pathTag = oldPath !== '' ? ` [${oldPath}]` : ''
    const indexLine = `- [${indexSafe(newTitle)}](memories/${rawId}.md) — ${indexSafe(safeSlice(newContent.split('\n')[0] ?? '', 80))} (${date})${pathTag}${tagSuffix}`
    const lines = (await readIndex(base)).filter(l => !l.includes(`(memories/${rawId}.md)`))
    lines.unshift(indexLine)
    const kept = await writeIndexGuarded(base, lines)
    reply(200, { ok: true, updated: rawId, title: newTitle, indexEntries: kept })
  } catch (e) {
    reply(400, { ok: false, error: String((e as Error)?.message ?? e) })
  }
}

/**
 * Discover manually-created nested memory scopes (a .dsh/memory copied into a
 * sub-folder — an intentional sub-project scope per the resolution chain).
 * Restricted BFS from each known workspace root: depth-capped, skipping
 * vendor/build directories, so the panel lists them without any registry.
 */
function findNestedScopes(root: string, maxDepth = 3): string[] {
  const SKIP = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', 'coverage', '.turbo', 'target', 'vendor'])
  const found: string[] = []
  let level: string[] = [root]
  const seen = new Set<string>([root])
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let names: string[] = []
      try { names = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { continue }
      for (const name of names) {
        if (SKIP.has(name) || name.startsWith('.') && name !== '.dsh') continue
        const child = path.join(dir, name)
        if (seen.has(child)) continue
        seen.add(child)
        if (existsSync(path.join(child, '.dsh', 'memory'))) { found.push(child); continue } // nested scope: don't descend into it further
        next.push(child)
      }
    }
    level = next
  }
  return found
}

/**
 * Panel read endpoint (P2.2): { scope, workspace?, id } → full memory text
 * for the edit form. The panel list only carries index-line excerpts; the
 * original content is fetched on demand, one memory at a time.
 */
async function handlePanelRead(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
  try {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(chunk as Buffer)
      if (chunks.reduce((n, c) => n + c.length, 0) > 10_000) { reply(413, { ok: false, error: 'body too large' }); return }
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { scope?: unknown, workspace?: unknown, id?: unknown }
    const id = String(body.id ?? '').replace(/\.md$/, '')
    if (!/^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(id)) { reply(400, { ok: false, error: 'invalid id' }); return }
    let base: string | undefined
    if (body.scope === 'user') {
      base = scopeDir('user')
    } else if (body.scope === 'project') {
      if (body.workspace !== undefined) {
        const root = path.resolve(String(body.workspace))
        if (!(await knownWorkspaces(ctx)).includes(root)) { reply(400, { ok: false, error: 'unknown workspace' }); return }
        base = path.join(root, '.dsh', 'memory')
      } else {
        base = PROJECT_DIR
      }
    } else {
      reply(400, { ok: false, error: 'scope must be "user" or "project"' }); return
    }
    if (base === undefined) { reply(400, { ok: false, error: 'target scope unavailable' }); return }
    const file = path.join(memoryDirOf(base), `${id}.md`)
    if (!existsSync(file)) { reply(404, { ok: false, error: 'memory not found' }); return }
    const text = await fs.readFile(file, 'utf8')
    const fm = /^---\n([\s\S]*?)\n---\n\n# (.*)\n\n([\s\S]*)$/.exec(text)
    if (fm === null) { reply(422, { ok: false, error: 'unrecognized memory file format' }); return }
    const memPath = /^path: (.*)$/m.exec(fm[1]!)?.[1] ?? ''
    const tags = (/^tags: (.*)$/m.exec(fm[1]!)?.[1] ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
    reply(200, { ok: true, id, title: fm[2], content: fm[3]!.replace(/\n$/, ''), path: memPath, tags }) // strip the storage-format trailing newline
  } catch (e) {
    reply(400, { ok: false, error: String((e as Error)?.message ?? e) })
  }
}

function excerpt(text: string, query: string, radius = 60): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return text.slice(0, radius * 2).trim()
  const start = Math.max(0, at - radius)
  return (start > 0 ? '…' : '') + text.slice(start, at + query.length + radius).trim() + (at + query.length + radius < text.length ? '…' : '')
}

const SAVE_DESCRIPTION = [
  'Save a durable memory that persists across sessions. Proactively call this whenever the conversation reveals information worth remembering long-term:',
  "the user's preferences, working habits, or corrections; project decisions and their rationale; key facts, numbers, or IDs; task outcomes and lessons learned.",
  'Scope rule: personal cross-project preferences go to scope "user"; project decisions and conventions go to scope "project" (team-shared, committed to git).',
  'Write rules: (1) strong-evidence default — before saving, ask "will this still matter a month from now?"; if unsure, skip it, memory noise costs more than memory gaps; (2) dedupe-and-update — saving a topic that already exists updates that memory in place instead of appending a duplicate; (3) never save secrets — if the content contains credentials, tokens, or passwords, refuse to save and tell the user to keep secrets out of chat.',
].join(' ')

const SEARCH_DESCRIPTION = 'Search saved memories by keyword (case-insensitive substring match across titles, tags, and content). Call this when prior context, user preferences, or earlier decisions may be relevant to the current task — before re-asking the user.'

/** Narrow structural type for the host webServer route service (P1 panel data bridge). */
interface WebServerRouteService {
  register(route: { method: string, path: string, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }): () => void
}

/** Parse one index line into a panel entry (tolerant: unparseable lines degrade, never throw). */
function parseEntryLine(line: string): Record<string, unknown> {
  const m = /^- \[([^\]]*)\]\(memories\/([^)]+)\) — (.*)$/.exec(line)
  if (m === null) return { title: line.slice(2, 62), date: '', path: '', tags: [], excerpt: '' }
  const rest = m[3]!
  const dateM = /\((\d{4}-\d{2}-\d{2})\)/.exec(rest)
  const pathM = /\) \[([^\]]+)\]/.exec(rest)
  const tags = [...rest.matchAll(/`([^`]+)`/g)].map(t => t[1]!)
  const excerpt = rest.split(' (')[0]!.slice(0, 100)
  return { id: m[2], title: m[1]!, date: dateM?.[1] ?? '', path: pathM?.[1] ?? '', tags, excerpt }
}

/** Per-scope stats + entries snapshot (sync; panel GET). */
function scopeStats(base: string): { stats: Record<string, number>, entries: Array<Record<string, unknown>> } {
  let lines: string[] = []
  try { lines = parseIndexLines(readFileSync(indexFileOf(base), 'utf8'), base) } catch { lines = [] } // orphan-filtered
  let indexBytes = 0
  try { indexBytes = statSync(indexFileOf(base)).size } catch { indexBytes = 0 }
  let memoryFiles = 0
  try { memoryFiles = readdirSync(memoryDirOf(base)).filter(f => f.endsWith('.md')).length } catch { memoryFiles = 0 }
  return {
    stats: {
      entries: lines.length, maxEntries: MAX_INDEX_LINES,
      indexBytes, maxBytes: MAX_INDEX_BYTES,
      memoryFiles, maxMemories: MAX_MEMORIES,
    },
    entries: lines.map(parseEntryLine),
  }
}

/**
 * Assemble the panel payload (P2): the user scope plus one expandable group
 * per known workspace (host registry union the user-scope ledger). Workspaces
 * without a .dsh/memory directory — nothing ever saved there — are skipped;
 * the current workspace sorts first and is marked current.
 */
async function buildPanelPayload(ctx: Context): Promise<Record<string, unknown>> {
  const scopes: Record<string, unknown> = {}
  const userBase = scopeDir('user')
  if (userBase === undefined) {
    scopes.user = { available: false }
  } else {
    const s = scopeStats(userBase)
    scopes.user = { available: true, stats: s.stats, entries: s.entries }
  }
  const currentRoot = PROJECT_DIR === undefined ? undefined : path.resolve(PROJECT_DIR, '..', '..')
  const workspaces = await knownWorkspaces(ctx)
  const ordered = currentRoot !== undefined ? [currentRoot, ...workspaces.filter(w => w !== currentRoot)] : workspaces
  const seen = new Set<string>()
  const projects: Array<Record<string, unknown>> = []
  for (const root of ordered) {
    if (seen.has(root)) continue
    seen.add(root)
    const base = path.join(root, '.dsh', 'memory')
    if (existsSync(base)) { // nothing ever saved in a workspace without it — but a nested scope inside may still exist
      const s = scopeStats(base)
      projects.push({ root, name: path.basename(root) || root, current: root === currentRoot, stats: s.stats, entries: s.entries })
    }
  }
  // nested scopes: a sub-folder .dsh/memory may be discoverable from several
  // roots (e.g. the cwd-fallback current root and its real parent workspace);
  // name each after the CLOSEST parent — the shortest relative path wins.
  const nestedNames = new Map<string, string>()
  for (const root of ordered) {
    for (const nested of findNestedScopes(root)) {
      const rel = path.relative(root, nested) || path.basename(nested)
      const existing = nestedNames.get(nested)
      if (existing === undefined || rel.length < existing.length) nestedNames.set(nested, rel)
    }
  }
  for (const [nestedRoot, name] of nestedNames) {
    if (seen.has(nestedRoot)) continue
    seen.add(nestedRoot)
    const s = scopeStats(path.join(nestedRoot, '.dsh', 'memory'))
    projects.push({ root: nestedRoot, name, nested: true, current: nestedRoot === currentRoot, stats: s.stats, entries: s.entries })
  }
  scopes.projects = projects
  return { scopes }
}

function simpleError(code: string, message: string): { code: string, message: string } {
  return { code, message }
}

/* ------------------------------------------------------------------ *
 * Plugin entry                                                        *
 * ------------------------------------------------------------------ */

/**
 * Inject both scopes' memory indexes into the system prompt — the Claude Code
 * "wake up with your memories" behavior, now hierarchical: user-level
 * preferences plus project-level (team-shared) memories are seeded together.
 */
/**
 * Narrow structural type for the host systemPrompt service, matching the
 * usage shipped by official tools (dsh-tool-fs: section({name, order, text})
 * and getSectionOrder(key)). Declared locally because the service's defining
 * package is internal to the DSH host; hosts without the service simply skip
 * auto-injection while all four tools keep working.
 */
interface SystemPromptService {
  getSectionOrder(key: string): number
  section(spec: { name: string, order?: number, text: (args: unknown) => string }): unknown
}

/**
 * Structural type for the host's per-assembly arguments (dsh-system-prompt
 * AssembleContext): an opaque scope key plus the turn's signal. Declared
 * locally — the defining package is internal to the DSH host.
 */
interface AssembleArgs { agent?: unknown, scope?: unknown, signal?: unknown }

/**
 * The canonical session-carrying path on an agent instance, mirroring how the
 * official agent loop itself reads it:
 * ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd)
 * (dsh-agent-loop, assembleContextFor sets { agent, scope: agent }).
 */
function sessionCwdOfAgent(agent: unknown): string | undefined {
  if (agent === null || typeof agent !== 'object') return undefined
  const session = (agent as Record<string, unknown>).session
  if (session === null || typeof session !== 'object') return undefined
  const header = (session as Record<string, unknown>).header
  if (header === null || typeof header !== 'object') return undefined
  const cwd = (header as Record<string, unknown>).cwd
  return typeof cwd === 'string' && path.isAbsolute(cwd) && cwd.length > 1 ? cwd : undefined
}

/**
 * v0.11 session-scoped injection: duck-probe the session's working directory
 * off the opaque scope key. Host internals are not exported, so several
 * plausible shapes are accepted (agent cwd / meta.cwd / session.{cwd,meta.cwd}
 * / workspace.path); an absolute existing-style string wins. Returns undefined
 * when the key carries nothing readable — callers then keep the legacy
 * process-cwd behavior (correct for single-workspace hosts).
 */
function extractSessionCwd(scope: unknown): string | undefined {
  if (scope === null || typeof scope !== 'object') return undefined
  const s = scope as Record<string, unknown>
  const meta = typeof s.meta === 'object' && s.meta !== null ? s.meta as Record<string, unknown> : undefined
  const session = typeof s.session === 'object' && s.session !== null ? s.session as Record<string, unknown> : undefined
  const sessionMeta = session !== undefined && typeof session.meta === 'object' && session.meta !== null ? session.meta as Record<string, unknown> : undefined
  const workspace = typeof s.workspace === 'object' && s.workspace !== null ? s.workspace as Record<string, unknown> : undefined
  for (const raw of [s.cwd, meta?.cwd, session?.cwd, sessionMeta?.cwd, workspace?.path]) {
    if (typeof raw === 'string' && path.isAbsolute(raw) && raw.length > 1) return raw
  }
  return undefined
}

/** Per-session project-base cache: text() re-evaluates every agent step, and
 * the upward root walk is pure filesystem — memoize by session cwd. */
const sessionProjectBaseCache = new Map<string, string | undefined>()

function projectBaseFor(cwd: string): string | undefined {
  const cached = sessionProjectBaseCache.get(cwd)
  if (cached !== undefined || sessionProjectBaseCache.has(cwd)) return cached
  const base = resolveProjectScope(cwd).dir // resolveProjectScope already returns <root>/.dsh/memory
  if (sessionProjectBaseCache.size > 100) sessionProjectBaseCache.clear()
  sessionProjectBaseCache.set(cwd, base)
  return base
}

function registerMemoryGuidance(ctx: Context): void {
  const systemPrompt = (ctx as unknown as { systemPrompt?: SystemPromptService }).systemPrompt
  if (systemPrompt === undefined) return // host composition has no systemPrompt service
  // order is REQUIRED and must be a finite number (dsh-system-prompt throws
  // on non-finite orders). 'TOOL_GOAL' is an existing official section key —
  // the memory block sits next to the other cross-turn tool guidance.
  // 'TOOLS' does not exist and yields NaN (found via real DSH host debugging).
  let order: number
  try {
    const raw = systemPrompt.getSectionOrder('TOOL_GOAL')
    order = typeof raw === 'number' && Number.isFinite(raw) ? raw : 500
  } catch {
    order = 500
  }
  systemPrompt.section({
    name: 'dsh-memory:auto',
    order,
    text: (context: unknown) => {
      const args = context as AssembleArgs | undefined
      // v0.11: each assembly carries the calling session's scope key; when it
      // exposes a working directory, both the injected project scope and the
      // path-tag filter follow THAT session (multi-workspace web hosts run
      // many sessions with different cwds). Without it we keep the legacy
      // process-wide behavior — still correct for single-workspace hosts.
      const sessionCwd = sessionCwdOfAgent(args?.agent) ?? sessionCwdOfAgent(args?.scope) ?? extractSessionCwd(args?.scope) ?? process.cwd()
      const projectBase = projectBaseFor(sessionCwd) ?? scopeDir('project')
      const sections: string[] = []
      for (const scope of activeScopes()) {
        const base = scope === 'project' ? projectBase : scopeDir(scope)
        if (base === undefined) continue
        let index = ''
        try {
          index = readFileSync(indexFileOf(base), 'utf8')
        } catch {
          continue // nothing remembered in this scope yet
        }
        let lines = parseIndexLines(index, base) // orphans (deleted memory files) stay out of the prompt
        let hiddenElsewhere = 0
        if (scope === 'project' && base !== undefined) {
          // CLAUDE.md-style lazy injection: root-level (untagged) project
          // memories always inject; path-tagged memories only inject when the
          // session's working directory falls inside that path — "you see
          // memories for where you work."
          const projRoot = path.resolve(base, '..', '..')
          const cwd = sessionCwd
          // path-boundary check: a same-prefix sibling (myproj vs myproj0)
          // must not be treated as inside the project
          const rel = cwd.startsWith(projRoot + path.sep) ? path.relative(projRoot, cwd).split(path.sep).join('/') : ''
          const matched: string[] = []
          for (const l of lines) {
            // path tag is anchored right after the (YYYY-MM-DD) date stamp —
            // brackets inside a title or excerpt can never be misread as a tag
            const m = /\(\d{4}-\d{2}-\d{2}\) \[([^\]]+)\]/.exec(l)
            if (m === null) { matched.push(l); continue } // no path tag = root-level
            const memPath = m[1]!
            if (memPath === rel || rel.startsWith(memPath + '/') || memPath.startsWith(rel + '/')) matched.push(l)
            else hiddenElsewhere++
          }
          lines = matched
        }
        const shown = lines.slice(0, 25)
        if (shown.length === 0 && hiddenElsewhere === 0) continue
        const label = scope === 'user' ? 'User memories (cross-project, personal)' : 'Project memories (team-shared, filtered to your working area)'
        let sectionText = `### ${label}, newest first:\n` + shown.join('\n')
        if (hiddenElsewhere > 0) {
          // Two-stage lazy loading (v0.7): nothing is silently hidden — the
          // index says how many memories exist outside the current working
          // area; memory_search surfaces them on demand, so context cost is
          // paid only when actually needed.
          const hint = shown.length > 0
            ? `+${hiddenElsewhere} more tagged to other areas of this project — memory_search surfaces them.`
            : `all ${hiddenElsewhere} memories in this project are tagged to other areas — memory_search surfaces them.`
          sectionText += (shown.length > 0 ? '\n' : '') + `(${hint})`
        }
        sections.push(sectionText)
      }
      if (sections.length === 0) return ''
      return '## Persistent memory (cross-session)\n'
        + sections.join('\n\n')
        + '\n\nUse memory_search / memory_read when prior context, user preferences, or earlier decisions may matter — before re-asking the user. '
        + 'Proactively memory_save important new facts as they appear: personal preferences → scope "user"; project decisions/conventions → scope "project". Write rules: ask "will this still matter a month from now?" before saving (skip if unsure — noise costs more than gaps); same-topic saves update the existing memory in place; dated index lines show what is fresh. Never save secrets or transient details.'
    },
  })
}

export async function apply(ctx: Context): Promise<void> {
  await refineWithWorkspaceRegistry(ctx)
  registerMemoryGuidance(ctx)

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: SAVE_DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: 'Short title (max ~60 chars) shown in the index.' },
      content: { type: 'string', required: true, description: 'The memory itself. Self-contained plain text or markdown; will matter months later without this chat.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional topical tags for retrieval.' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'Where to store: "project" = team-shared decisions/conventions, committed to git (default inside a git repository); "user" = personal cross-project preferences (default outside a repo).' },
      path: { type: 'string', description: 'Optional sub-directory this memory belongs to (relative to project root, e.g. "frontend/src"). Auto-recorded from working directory if omitted. Untagged (root-level) memories always inject; path-tagged memories only inject when the session works in that area.' },
    },
    output: {
      // Loose object schema: execute returns either the success value or a
      // {code,message} domain-error value (both are valid canonical values).
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { title: string, content: string, tags?: string[], scope?: 'user' | 'project', path?: string }, exec: { signal: AbortSignal, agent?: unknown } | { signal: AbortSignal }) {
      if (exec.signal.aborted) return simpleError('aborted', 'Save aborted before completion.')
      const title = safeSlice(args.title.trim(), 60)
      const content = safeSlice(args.content.trim(), MAX_CONTENT_CHARS)
      if (!title || !content) return simpleError('invalid_input', 'title and content must be non-empty.')
      // v0.11 write-side session scoping: the agent loop sets exec.agent; its
      // session header cwd decides BOTH the default project scope and the
      // path tag — reads and writes now target the same per-session workspace
      // bucket (the rc1 read-only asymmetry is gone). Legacy hosts without
      // exec.agent keep the process-anchored behavior.
      const sessionCwd = sessionCwdOfAgent((exec as { agent?: unknown }).agent)
      const sessionBase = sessionCwd === undefined ? undefined : projectBaseFor(sessionCwd)
      let scope = args.scope
      if (scope === undefined) scope = (sessionBase ?? PROJECT_DIR) === undefined ? 'user' : 'project'
      const base = scope === 'project' ? (sessionBase ?? scopeDir('project')) : scopeDir('user')
      if (base === undefined) return simpleError('no_project_scope', 'No git repository detected here; only the "user" scope is available.')
      const r = await saveMemoryCore({ scope, base, title, content, tags: args.tags, memPathArg: args.path, sessionCwd })
      return r.ok ? r : simpleError('save_failed', r.error)
    },
    presentCall: args => ({ card: 'generic' as const, title: `Save memory: ${args.title}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword or phrase to look for.' },
      limit: { type: 'number', description: `Max results (default ${DEFAULT_SEARCH_LIMIT}, max 20).` },
      scope: { type: 'string', enum: ['user', 'project'], description: 'Restrict search to one scope; default searches both.' },
    },
    output: {
      // Loose object schema: execute returns either the success value or a
      // {code,message} domain-error value (both are valid canonical values).
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { query: string, limit?: number, scope?: 'user' | 'project' }, exec) {
      if (exec.signal.aborted) return simpleError('aborted', 'Search aborted.')
      const q = args.query.trim()
      if (!q) return simpleError('invalid_input', 'query must be non-empty.')
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_SEARCH_LIMIT), 1), 20)
      const lower = q.toLowerCase()
      const scopes = args.scope === undefined ? activeScopes() : [args.scope]
      const matches: Array<{ scope: string, id: string, title: string, excerpt: string }> = []
      for (const scope of scopes) {
        const base = scopeDir(scope)
        if (base === undefined) continue
        const dir = memoryDirOf(base)
        const files = (await fs.readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.md')).sort().reverse()
        for (const f of files) {
          if (matches.length >= limit) break
          if (f.toLowerCase().includes(lower)) {
            matches.push({ scope, id: f.replace(/\.md$/, ''), title: f.replace(/\.md$/, ''), excerpt: '(id match)' })
            continue
          }
          const text = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '')
          if (text.toLowerCase().includes(lower)) {
            const titleLine = /^#\s+(.+)$/m.exec(text)?.[1] ?? f
            matches.push({ scope, id: f.replace(/\.md$/, ''), title: titleLine, excerpt: excerpt(text, q) })
          }
        }
      }
      return { query: q, total: matches.length, matches }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Search memory: ${args.query}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read one full memory by id (as returned by memory_search or memory_list). Uses when an excerpt looks relevant and the complete context matters. Project scope is checked first, then user scope.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id, e.g. 20261004-181500-prefer-pnpm.' },
    },
    output: {
      // Loose object schema: execute returns either the success value or a
      // {code,message} domain-error value (both are valid canonical values).
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { id: string }, exec) {
      if (exec.signal.aborted) return simpleError('aborted', 'Read aborted.')
      const safe = args.id.replace(/[^a-zA-Z0-9\u4e00-\u9fff-]/g, '')
      // Field set mirrors Claude Code's shipped project_memory_read contract
      // (sdk-tools.d.ts): content?, local_file?, size_bytes, updated_at,
      // truncated — oversized memories return a truncated preview plus the
      // on-disk path instead of flooding the context window.
      for (const scope of ['project', 'user'] as const) {
        const base = scopeDir(scope)
        if (base === undefined) continue
        const file = path.join(memoryDirOf(base), `${safe}.md`)
        try {
          const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
          const size_bytes = stat.size
          const updated_at = stat.mtime.toISOString()
          if (content.length > 4000) {
            let cut = content.slice(0, 4000)
            const last = cut.charCodeAt(cut.length - 1)
            if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1) // don't split a surrogate pair
            return { id: safe, scope, content: cut, truncated: true, local_file: file, size_bytes, updated_at }
          }
          // identical field set in both branches: Record<string, JsonValue> rejects undefined-valued keys
          return { id: safe, scope, content, truncated: false, local_file: file, size_bytes, updated_at }
        } catch {
          continue
        }
      }
      return simpleError('memory_not_found', `No memory with id ${safe}. Use memory_search to find valid ids.`)
    },
    presentCall: args => ({ card: 'generic' as const, title: `Read memory: ${args.id}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List the most recent memories from both scopes, newest first. Good for a quick orientation at session start; prefer memory_search for topical lookup.',
    parameters: {
      limit: { type: 'number', description: `Max entries per scope (default ${DEFAULT_SEARCH_LIMIT}, max 50).` },
    },
    output: {
      // Loose object schema: execute returns either the success value or a
      // {code,message} domain-error value (both are valid canonical values).
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { limit?: number }, exec) {
      if (exec.signal.aborted) return simpleError('aborted', 'List aborted.')
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_SEARCH_LIMIT), 1), 50)
      const out: Record<string, { total: number, truncated: boolean, entries: string[] }> = {}
      for (const scope of activeScopes()) {
        const base = scopeDir(scope)
        if (base === undefined) continue
        const all = await readIndex(base)
        const lines = all.slice(0, limit)
        out[scope] = { total: lines.length, truncated: all.length > lines.length, entries: lines }
      }
      return out
    },
    presentCall: () => ({ card: 'generic' as const, title: 'List memories (both scopes)' }),
  }))

  // P1 visual editor data bridge: a read-only JSON API served by the host
  // webServer. Runtime-injected (NOT a top-level inject) so hosts without a
  // web server keep every tool working — the panel just has no data source.
  void recordWorkspace()
  if (typeof ctx.inject !== 'function') return // minimal hosts/test stubs without runtime inject: tools keep working, panel has no data source
  ctx.inject(['webServer'], (webCtx: Context) => {
    const webServer = (webCtx as unknown as { webServer?: WebServerRouteService }).webServer
    if (webServer === undefined) return
    webServer.register({
      method: 'GET',
      path: '/dsh-memory/api/v1/list',
      handler: (_request, response) => {
        void buildPanelPayload(ctx).then(payload => {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(payload))
        }).catch(() => {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: 'panel payload failed' }))
        })
      },
    })
    webServer.register({
      method: 'POST',
      path: '/dsh-memory/api/v1/save',
      handler: (request, response) => {
        void handlePanelSave(ctx, request, response)
      },
    })
    webServer.register({
      method: 'POST',
      path: '/dsh-memory/api/v1/delete',
      handler: (request, response) => {
        void handlePanelDelete(ctx, request, response)
      },
    })
    webServer.register({
      method: 'POST',
      path: '/dsh-memory/api/v1/update',
      handler: (request, response) => {
        void handlePanelUpdate(ctx, request, response)
      },
    })
    webServer.register({
      method: 'POST',
      path: '/dsh-memory/api/v1/read',
      handler: (request, response) => {
        void handlePanelRead(ctx, request, response)
      },
    })
  })
}
