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

const MAX_WALK_LEVELS = 16 // C8: deep monorepos split buckets at 8 levels
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
/** B4: shared guarded-directory predicate — home, ANY filesystem root ('/', 'C:\', …),
 * and the tmp dirs. One copy for every consumer (scope walk, env override,
 * workspace-registry refinement) — divergent copies let platform gaps creep back in. */
function isGuardedDir(p: string, home: string): boolean {
  const r = path.resolve(p)
  if (r === home) return true
  if (path.parse(r).root === r) return true // any filesystem root ('/', 'C:\', …) — literal '/tmp' misses drive roots on Windows
  const tmp = path.resolve(os.tmpdir())
  return r === tmp || r === '/tmp' || r === '/private/tmp'
}

export function resolveProjectScope(startDir: string = process.cwd(), opts: { homeDir?: string } = {}): ProjectResolution {
  const home = path.resolve(opts.homeDir ?? os.homedir())
  const guarded = (d: string): boolean => isGuardedDir(d, home)
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
  const registry = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as { list(): Promise<unknown[]> } | undefined // A3: undeclared-inject property reads throw on lean fibers; ctx.get is the official inject-free read
  if (registry === undefined || typeof registry.list !== 'function') return
  try {
    const entries = await registry.list()
    const cwd = process.cwd()
    let best: string | undefined
    for (const entry of entries) {
      const e = entry as Record<string, unknown>
      const raw = e.path ?? (typeof e.directory === 'function' ? String(e.directory()) : e.directory) // A4: real Workspace field is `path`; `directory` kept as legacy shape
      if (typeof raw !== 'string' || !path.isAbsolute(raw)) continue
      const root = path.resolve(raw)
      const rel = path.relative(root, cwd)
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        if (best === undefined || root.length > best.length) best = root // deepest ancestor wins
      }
    }
    if (best !== undefined) {
      // B4: the SAME shared guard as the scope walk — a registry-supplied drive
      // root ('E:\') or tmp dir is no more a durable project boundary here
      if (!isGuardedDir(best, path.resolve(os.homedir()))) {
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

/** High-confidence credential shapes (C5): key blocks and well-known token prefixes. */
const SECRET_PATTERN = /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,}|xox[bap]-[0-9A-Za-z-]{20,}/

/** A tag must not carry the two characters that structure the index line and the frontmatter. */
const sanitizeTag = (t: string) => t.replace(/[`,]/g, '').trim()

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
  // R6 (PR1): single shared atomic-write implementation — file integrity
  // guaranteed; last-writer-wins between concurrent writers is a known
  // limitation (the index cap prunes the damage).
  await atomicWriteFile(indexFileOf(base), INDEX_HEADER + kept.join('\n') + '\n')
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
  const tags = (input.tags ?? []).map(sanitizeTag).filter(t => t !== '')

  // C5: lightweight high-confidence secret scan — credential-shaped content
  // is refused at the code level, not only by prompt rule.
  if (SECRET_PATTERN.test(title) || SECRET_PATTERN.test(content)) {
    return { ok: false, error: 'refused: content looks like a credential or private key — never save secrets' }
  }
  try {
    const now = new Date()
    const slug = slugify(title)
    const date = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
    await ensureDirs(base)
    const dir = memoryDirOf(base)
    // Claude-Code write rule — dedupe-and-update: same title slug updates in
    // place instead of appending a near-duplicate.
    // BUG A fix (v0.11.4): suffix matching (`endsWith('-' + slug)`) let a
    // short title (e.g. "test") silently OVERWRITE an unrelated memory whose
    // slug it terminates ("my-test"). Match the exact id segment instead:
    // <YYYYMMDD-HHmmss>-<slug>.md with the slug regex-escaped.
    const idPattern = new RegExp(`^\\d{8}-\\d{6}-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md$`)
    const existing = (await fs.readdir(dir).catch(() => [] as string[])).find(f => idPattern.test(f))
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
    const header = `---\nid: ${id}\nscope: ${scope}\npath: ${memPath}\nsaved_at: ${now.toISOString()}\ntags: ${tags.join(', ')}\n---\n\n# ${title}\n\n`
    await atomicWriteFile(file, header + content + '\n')
    const tagSuffix = tags.length ? ` \`${tags.slice(0, 3).join('` `')}\`` : '' // index line caps at 3 tags — it injects every turn; full tags stay in frontmatter for search
    const pathTag = memPath !== '' ? ` [${memPath}]` : ''
    const indexLine = `- [${indexSafe(title)}](memories/${id}.md) — ${indexSafe(safeSlice(content.split('\n')[0] ?? '', 80))} (${date})${pathTag}${tagSuffix}`
    const lines = (await readIndex(base)).filter(l => !l.includes(`(memories/${id}.md)`))
    lines.unshift(indexLine)
    const kept = await writeIndexGuarded(base, lines)
    const pruned = updated ? 0 : await pruneMemories(base)
    if (scope === 'project') void recordSessionWorkspace(path.resolve(base, '..', '..')) // panel enumeration sees this workspace next refresh
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
async function knownWorkspaces(ctx: Context): Promise<{ roots: string[], titles: Map<string, string> }> {
  const roots = new Set<string>()
  const titles = new Map<string, string>()
  try {
    const registry = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as { list(): Promise<unknown[]> } | undefined // A3: undeclared-inject property reads throw on lean fibers; ctx.get is the official inject-free read
    if (registry !== undefined && typeof registry.list === 'function') {
      for (const entry of await registry.list()) {
        const e = entry as Record<string, unknown>
        const raw = e.path ?? (typeof e.directory === 'function' ? String(e.directory()) : e.directory) // A4
        if (typeof raw === 'string' && path.isAbsolute(raw)) {
          const resolved = path.resolve(raw)
          roots.add(resolved)
          // F5: the GUI renames a workspace's TITLE (the path never rewrites —
          // host Workspace contract); the panel must display it, falling back
          // to the basename for registry entries without a usable title and
          // for ledger-only workspaces.
          if (typeof e.title === 'string' && e.title.trim() !== '') titles.set(resolved, e.title.trim())
        }
      }
    }
  } catch { /* best-effort */ }
  try {
    const ledger = JSON.parse(readFileSync(path.join(USER_DIR, 'workspaces.json'), 'utf8')).workspaces
    for (const w of Array.isArray(ledger) ? ledger : []) {
      if (typeof w === 'string' && path.isAbsolute(w)) roots.add(path.resolve(w))
    }
  } catch { /* absent → skip */ }
  return { roots: [...roots], titles }
}

/**
 * Panel save endpoint (P2): { scope, workspace?, title, content, tags? }.
 * A project save may target any KNOWN workspace (registry or ledger) — an
 * arbitrary path is rejected, so the browser can never use this API as a
 * general-purpose file writer.
 */
type PanelReply = (status: number, body: unknown) => void

function panelReply(response: ServerResponse): PanelReply {
  return (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
}

/** Shared body reader (PR1): size-capped, JSON-parsed; replies and returns undefined on failure. */
async function readPanelBody(request: IncomingMessage, maxBytes: number, reply: PanelReply): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > maxBytes) { reply(413, { ok: false, error: 'body too large' }); return undefined }
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch (e) {
    reply(400, { ok: false, error: String((e as Error)?.message ?? e) })
    return undefined
  }
}

/** Shared id validation (PR1): strips a .md suffix, enforces the slug charset — no path traversal. */
function panelIdOf(body: Record<string, unknown>, reply: PanelReply): string | undefined {
  const id = String(body.id ?? '').replace(/\.md$/, '')
  if (!/^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(id)) { reply(400, { ok: false, error: 'invalid id' }); return undefined }
  return id
}

/**
 * Shared scope→base resolution (PR1): user / project-with-known-workspace /
 * project-anchor. Always replies on failure, so callers can treat undefined
 * as "handled".
 */
async function resolvePanelBase(ctx: Context, body: Record<string, unknown>, reply: PanelReply): Promise<string | undefined> {
  if (body.scope === 'user') {
    const b = scopeDir('user')
    if (b === undefined) { reply(400, { ok: false, error: 'target scope unavailable' }); return undefined }
    return b
  }
  if (body.scope === 'project') {
    if (body.workspace !== undefined) {
      const root = path.resolve(String(body.workspace))
      if (!(await knownWorkspaces(ctx)).roots.includes(root)) { reply(400, { ok: false, error: 'unknown workspace' }); return undefined }
      return path.join(root, '.dsh', 'memory')
    }
    if (PROJECT_DIR === undefined) { reply(400, { ok: false, error: 'target scope unavailable' }); return undefined }
    return PROJECT_DIR
  }
  reply(400, { ok: false, error: 'scope must be "user" or "project"' })
  return undefined
}

async function handlePanelSave(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = panelReply(response)
  try {
    const body = await readPanelBody(request, 1000000, reply)
    if (body === undefined) return
    const title = safeSlice(String(body.title ?? '').trim(), 60)
    const content = safeSlice(String(body.content ?? '').trim(), MAX_CONTENT_CHARS)
    const tags = (Array.isArray(body.tags) ? body.tags : []).filter((t): t is string => typeof t === 'string').slice(0, 10)
    if (title === '' || content === '') { reply(400, { ok: false, error: 'title and content must be non-empty' }); return }
    const base = await resolvePanelBase(ctx, body, reply)
    if (base === undefined) return
    const r = await saveMemoryCore({ scope: body.scope as 'user' | 'project', base, title, content, tags, sessionCwd: '', memPathArg: typeof body.path === 'string' ? body.path : undefined }) // C1: panel saves are root-level unless an explicit path tag is given — never fall back to the process cwd
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
  const reply = panelReply(response)
  try {
    const body = await readPanelBody(request, 10000, reply)
    if (body === undefined) return
    const id = panelIdOf(body, reply)
    if (id === undefined) return
    const base = await resolvePanelBase(ctx, body, reply)
    if (base === undefined) return
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
  const reply = panelReply(response)
  try {
    const body = await readPanelBody(request, 1000000, reply)
    if (body === undefined) return
    const rawId = panelIdOf(body, reply)
    if (rawId === undefined) return
    const title = body.title === undefined ? undefined : safeSlice(String(body.title).trim(), 60)
    const content = body.content === undefined ? undefined : safeSlice(String(body.content).trim(), MAX_CONTENT_CHARS)
    const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : undefined
    if (title === '') { reply(400, { ok: false, error: 'title must be non-empty' }); return }
    if (content === '') { reply(400, { ok: false, error: 'content must be non-empty' }); return }
    const pathArg = typeof body.path === 'string' ? body.path.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff/_-]+/g, '-').replace(/^-+|-+$/g, '') : undefined
    const base = await resolvePanelBase(ctx, body, reply)
    if (base === undefined) return
    const file = path.join(memoryDirOf(base), `${rawId}.md`)
    if (!existsSync(file)) { reply(404, { ok: false, error: 'memory not found' }); return }
    const text = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n') // C9: hand-edited CRLF files stay editable
    const fm = /^---\n([\s\S]*?)\n---\n\n# (.*)\n\n([\s\S]*)$/.exec(text)
    if (fm === null) { reply(422, { ok: false, error: 'unrecognized memory file format' }); return }
    const oldPath = pathArg ?? (/^path: (.*)$/m.exec(fm[1]!)?.[1] ?? '') // C2: an explicit path arg re-tags the memory''
    const oldScope = /^scope: (.*)$/m.exec(fm[1]!)?.[1] ?? String(body.scope)
    const newTitle = title ?? fm[2]!
    const newContent = content ?? fm[3]!
    const newTags = (tags ?? (/^tags: (.*)$/m.exec(fm[1]!)?.[1] ?? '').split(',').map(s => s.trim()).filter(s => s !== '')).map(sanitizeTag).filter(t => t !== '')
    // C5: the SAME secret scan as the save path — update must not be the bypass
    if (SECRET_PATTERN.test(newTitle) || SECRET_PATTERN.test(newContent)) {
      reply(400, { ok: false, error: 'refused: content looks like a credential or private key — never save secrets' })
      return
    }
    const now = new Date()
    const date = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
    const header = `---\nid: ${rawId}\nscope: ${oldScope}\npath: ${oldPath}\nsaved_at: ${now.toISOString()}\ntags: ${newTags.join(', ')}\n---\n\n# ${newTitle}\n\n`
    await atomicWriteFile(file, header + newContent + '\n')
    const tagSuffix = newTags.length ? ` \`${newTags.slice(0, 3).join('` `')}\`` : ''
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

/** Ledger a workspace root a session actually SAVED into (v0.11.1): the save
 * itself is the strongest "this workspace is real" evidence, so unlike the
 * boot-time recordWorkspace there is no cwd-source guard. Fire-and-forget. */
async function recordSessionWorkspace(root: string): Promise<void> {
  try {
    const file = path.join(USER_DIR, 'workspaces.json')
    let parsed: unknown = []
    try { parsed = JSON.parse(readFileSync(file, 'utf8')).workspaces } catch { /* fresh */ }
    const list = (Array.isArray(parsed) ? parsed : []).filter((w): w is string => typeof w === 'string' && path.isAbsolute(w))
    if (list.includes(root)) return
    list.unshift(root)
    await atomicWriteFile(file, JSON.stringify({ workspaces: list.slice(0, 50) }, null, 2) + '\n')
  } catch { /* best-effort: a failed ledger write never blocks the save */ }
}

/**
 * v0.11.1: project-scope buckets a tool should touch for THIS call — the
 * calling session's workspace first (exec.agent, when the agent loop set it),
 * then the service-anchor bucket as fallback so pre-session-era memories
 * stay reachable. Deduped; single-element in single-workspace hosts.
 */
function projectBasesFor(ctx: Context, exec: unknown): string[] {
  const bases: string[] = []
  const agent = (exec as { agent?: unknown } | undefined)?.agent
  // retrieval tools must follow the SAME effective cwd as injection and
  // memory_save — workingDirectory first, frozen header.cwd as fallback —
  // or a cross-workspace cd saves into the new bucket but keeps searching
  // the old one.
  const sessionCwd = workingDirectoryCwd(ctx, agent) ?? sessionCwdOfAgent(agent)
  const sessionBase = sessionCwd === undefined ? undefined : projectBaseFor(sessionCwd)
  const anchorBase = scopeDir('project')
  if (sessionBase !== undefined) bases.push(sessionBase)
  if (anchorBase !== undefined && !bases.includes(anchorBase)) bases.push(anchorBase)
  return bases
}

const nestedScopesCache = new Map<string, { at: number, value: string[] }>()
const NESTED_SCOPES_TTL_MS = 5_000

/**
 * Discover manually-created nested memory scopes (PR5/C12): restricted BFS
 * from each known workspace root — depth-capped, skipping vendor dirs, now
 * ASYNC (the panel GET never blocks the event loop) behind a 5s TTL cache
 * (the client re-fetches after every save; the walk only reruns on expiry).
 */
async function findNestedScopes(root: string, maxDepth = 3): Promise<string[]> {
  const cached = nestedScopesCache.get(root)
  if (cached !== undefined && Date.now() - cached.at < NESTED_SCOPES_TTL_MS) return cached.value
  const SKIP = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', 'coverage', '.turbo', 'target', 'vendor'])
  const found: string[] = []
  let level: string[] = [root]
  const seen = new Set<string>([root])
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let entries: Array<{ name: string, isDirectory: () => boolean }> = []
      try {
        entries = await fs.readdir(dir, { withFileTypes: true }) as unknown as Array<{ name: string, isDirectory: () => boolean }>
      } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (SKIP.has(entry.name) || entry.name.startsWith('.') && entry.name !== '.dsh') continue
        const child = path.join(dir, entry.name)
        if (seen.has(child)) continue
        seen.add(child)
        if (existsSync(path.join(child, '.dsh', 'memory'))) { found.push(child); continue } // nested scope: don't descend further
        next.push(child)
      }
    }
    level = next
  }
  if (nestedScopesCache.size > 50) nestedScopesCache.clear()
  nestedScopesCache.set(root, { at: Date.now(), value: found })
  return found
}

/**
 * Panel read endpoint (P2.2): { scope, workspace?, id } → full memory text
 * for the edit form. The panel list only carries index-line excerpts; the
 * original content is fetched on demand, one memory at a time.
 */
async function handlePanelRead(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = panelReply(response)
  try {
    const body = await readPanelBody(request, 10000, reply)
    if (body === undefined) return
    const id = panelIdOf(body, reply)
    if (id === undefined) return
    const base = await resolvePanelBase(ctx, body, reply)
    if (base === undefined) return
    const file = path.join(memoryDirOf(base), `${id}.md`)
    if (!existsSync(file)) { reply(404, { ok: false, error: 'memory not found' }); return }
    const text = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n') // C9: hand-edited CRLF files stay editable
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
  'Save a durable memory that persists across sessions. Default bar: would this still matter a month from now? If unsure, skip it or ask the user first — memory noise costs more than memory gaps.',
  'SAVE: durable user preferences, habits, corrections; project decisions AND their rationale; conventions that outlive the task; lessons from a CONCLUDED investigation.',
  'DO NOT save: mid-investigation progress or state that will change ("currently broken/unfixed" is not a memory — save the conclusion once the task settles); anything derivable from the repo or git history; one-off task details; secrets (refuse and say so).',
  'Write style: an entry is an INSTRUCTION for a future agent, not a report — imperative and self-contained in 2-5 sentences ("use X; never Y because Z"); the title is a short directive, not a full sentence (the title becomes the injected index line — a sentence-length title wastes every future prompt); at most 3 tags — memory_search matches content, not tag count.',
  'Rules: (1) save at conclusions, never while still working; (2) one topic = one memory — the same feature/bug/investigation stays one entry; the dated index lines in your prompt show what already exists: check them and update in place instead of near-duplicating; (3) a session typically ends with zero to two new or updated memories; (4) scope: personal cross-project preferences → "user"; project decisions → "project" (team-shared, committed to git).',
].join(' ')

const SEARCH_DESCRIPTION = 'Search saved memories by keyword (case-insensitive substring match across titles, tags, and content). Call this when prior context, user preferences, or earlier decisions may be relevant to the current task — before re-asking the user.'

/**
 * Panel-endpoint origin gate (A1): the host does no auth on plugin routes
 * (gzip -> pathname -> handler), and the panel has no CORS headers — a
 * text/plain cross-site POST is a simple request, no preflight, so a hostile
 * page could blind-write memories that inject into the next session's system
 * prompt. Modern browsers are stopped by Sec-Fetch-Site + Origin-vs-Host;
 * DNS rebinding is stopped by the Host allow-list (localhost variants or a
 * bare IP — LAN access stays legal). Local clients without these headers pass.
 * Method policing also lives here (N3): each route declares its expected
 * method; an absent method (bare local client) passes like absent headers.
 */
function isTrustedPanelRequest(request: IncomingMessage, expectedMethod?: 'GET' | 'POST'): boolean {
  if (expectedMethod !== undefined && request.method !== undefined && request.method !== expectedMethod) return false
  const h = request.headers ?? {}
  const site = h['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = h.origin
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host !== h.host) return false
    } catch {
      return false
    }
  }
  const host = h.host
  if (host !== undefined
    && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
    && !/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)
    && !/^\[[0-9a-f:]+\](:\d+)?$/i.test(host)) return false
  return true
}

function refuseCrossOrigin(response: ServerResponse): void {
  response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ ok: false, error: 'cross-origin request refused' }))
}

/** Narrow structural type for the host webServer route service (P1 panel data bridge). */
interface WebServerRouteService {
  register(route: { kind: 'exact' | 'prefix', path: string, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }): () => void
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
  // B5: memories beyond the index cap (or orphaned by hand edits) stay
  // invisible to the panel even though search/read can still find them —
  // surface them as unindexed entries so the panel can edit/delete them too.
  const indexedFiles = new Set(lines.map(l => /\(memories\/([^)]+)\)/.exec(l)?.[1]).filter((x): x is string => x !== undefined))
  const entries: Array<Record<string, unknown>> = lines.map(parseEntryLine)
  let memFiles: string[] = []
  try { memFiles = readdirSync(memoryDirOf(base)).filter(f => f.endsWith('.md')) } catch { /* none */ }
  for (const f of memFiles) {
    if (indexedFiles.has(f)) continue
    try {
      const text = readFileSync(path.join(memoryDirOf(base), f), 'utf8').replace(/\r\n/g, '\n')
      const fm = /^---\n([\s\S]*?)\n---\n\n# (.*)\n\n([\s\S]*)$/.exec(text)
      const savedAt = /^saved_at: (.*)$/m.exec(fm?.[1] ?? '')?.[1] ?? ''
      entries.push({
        id: f.replace(/\.md$/, ''),
        title: fm?.[2] ?? f.replace(/\.md$/, ''),
        date: savedAt.slice(0, 10),
        path: /^path: (.*)$/m.exec(fm?.[1] ?? '')?.[1] ?? '',
        tags: (/^tags: (.*)$/m.exec(fm?.[1] ?? '')?.[1] ?? '').split(',').map(s => s.trim()).filter(s => s !== ''),
        excerpt: (fm?.[3] ?? '').split('\n')[0]?.slice(0, 100) ?? '',
        unindexed: true,
      })
    } catch { /* unreadable file stays hidden */ }
  }
  return {
    stats: {
      entries: lines.length, maxEntries: MAX_INDEX_LINES,
      indexBytes, maxBytes: MAX_INDEX_BYTES,
      memoryFiles, maxMemories: MAX_MEMORIES,
    },
    entries,
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
  const { roots, titles } = workspaces
  const ordered = currentRoot !== undefined ? [currentRoot, ...roots.filter(w => w !== currentRoot)] : roots
  const seen = new Set<string>()
  const projects: Array<Record<string, unknown>> = []
  for (const root of ordered) {
    if (seen.has(root)) continue
    seen.add(root)
    // Empty-state visibility (v0.11.2): a workspace whose directory exists
    // shows even with zero memories — the empty group is where the user adds
    // the first one. Only a workspace whose directory is GONE is filtered.
    if (!existsSync(root)) continue
    const base = path.join(root, '.dsh', 'memory')
    const s = scopeStats(base) // no .dsh/memory yet → all-zero stats + empty entries
    projects.push({ root, name: titles.get(root) ?? (path.basename(root) || root), serviceAnchor: root === currentRoot, stats: s.stats, entries: s.entries })
  }
  // nested scopes: a sub-folder .dsh/memory may be discoverable from several
  // roots (e.g. the cwd-fallback current root and its real parent workspace);
  // name each after the CLOSEST parent — the shortest relative path wins.
  const nestedNames = new Map<string, string>()
  for (const root of ordered) {
    for (const nested of await findNestedScopes(root)) {
      const rel = path.relative(root, nested) || path.basename(nested)
      const existing = nestedNames.get(nested)
      if (existing === undefined || rel.length < existing.length) nestedNames.set(nested, rel)
    }
  }
  for (const [nestedRoot, name] of nestedNames) {
    if (seen.has(nestedRoot)) continue
    seen.add(nestedRoot)
    const s = scopeStats(path.join(nestedRoot, '.dsh', 'memory'))
    projects.push({ root: nestedRoot, name, nested: true, serviceAnchor: nestedRoot === currentRoot, stats: s.stats, entries: s.entries })
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

/* ------------------------------------------------------------------ *
 * v0.13 CLAUDE.md-style touch activation (read/write-triggered tags)  *
 * ------------------------------------------------------------------ */

const TOUCHED_DIRS_KEY = 'dsh-memory:touched-dirs'
const TOUCHED_DIRS_CAP = 200

/**
 * Model tool → the argument naming a filesystem location it touches.
 * Verified against the official tool sources: tool-fs read/edit/write take
 * `file_path`; tool-fs-search grep/glob take `path`; shell bash/pwsh take
 * `workdir`.
 */
const TOUCH_TOOL_ARGS: Record<string, string> = {
  read: 'file_path', edit: 'file_path', write: 'file_path',
  grep: 'path', glob: 'path',
  bash: 'workdir', pwsh: 'workdir',
}

/**
 * Plain-JSON validator for the touched-dirs state. The projection registry
 * erases schemas to `{ parse(value) }` (its ErasedDefinition) and calls it
 * only when seeding from the persisted cache — this is the zero-dependency
 * equivalent of `z.array(z.union([z.string(), z.object({ cd: z.string() })]))`.
 * v2 items: a touch string, or a {cd} marker recording one working_directory
 * hop. Pure-string states (the v1 shape) parse unchanged — that IS the
 * one-time migration; persisted ver=1 rows are additionally discarded by the
 * registry on the version bump and refolded from the session log.
 */
const isTouchedDirsItem = (x: unknown): boolean =>
  (typeof x === 'string' && x !== '')
  || (typeof x === 'object' && x !== null && typeof (x as { cd?: unknown }).cd === 'string' && (x as { cd: string }).cd !== '')

const touchedDirsSchema = {
  parse(value: unknown): Array<string | { cd: string }> {
    if (!Array.isArray(value) || !value.every(isTouchedDirsItem)) throw new Error('touched-dirs state must be (string | {cd})[]')
    return value
  },
}

/** The official working-directory tool: `cd` enters a directory (omitted = read
 * the current one — verified against @deepseek-ai/dsh-tool-working-directory).
 * Its calls become {cd} state markers so injection can replay each touch's
 * historical cursor. */
const CD_TOOL = 'working_directory'

/**
 * Pure fold for TOUCHED_DIRS_KEY (v2, P1/P2 fix): touch tools append their
 * argument RAW — a relative path cannot be resolved here (the fold sees no
 * cwd), so working_directory calls are recorded as {cd} markers letting the
 * injection side REPLAY the cursor each touch was made under. Resolving
 * relatives against the assembly-time cwd instead would drop tags after a
 * cd back (P1) and leak tags into never-touched areas after a cd forward
 * (P2). Returns the SAME state reference when an event adds nothing — the
 * registry skips all downstream work on `Object.is`.
 * The state rides the session event log (via sessionProjections), so it
 * survives session resume and clears for fresh sessions — exactly the
 * CLAUDE.md semantics we want.
 */
function foldTouchedDirs(state: unknown, event: unknown): Array<string | { cd: string }> {
  const cur = state as Array<string | { cd: string }>
  const e = event as { type?: unknown, name?: unknown, arguments?: unknown } | undefined
  if (e === undefined || e.type !== 'tool/call') return cur
  const args = e.arguments as Record<string, unknown> | null | undefined
  const argOf = (name: string): unknown => args !== null && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined
  if (e.name === CD_TOOL) {
    const cd = argOf('cd')
    if (typeof cd !== 'string' || cd.trim() === '') return cur // read-mode call: the cursor does not move
    return pushTouchedCapped(cur, { cd })
  }
  const argName = typeof e.name === 'string' ? TOUCH_TOOL_ARGS[e.name] : undefined
  if (argName === undefined) return cur
  const raw = argOf(argName)
  if (typeof raw !== 'string' || raw.trim() === '') return cur
  // F6: dedup only within the CURRENT cursor segment — the items after the
  // last {cd} marker. Since 0.13.5 each relative touch replays against its
  // touch-time cursor, so the same string in different segments is a
  // DIFFERENT directory and must be recorded again; within one segment a
  // repeat is the same directory and stays idempotent (same-reference return
  // preserved for the Object.is contract).
  let segmentStart = 0
  for (let i = cur.length - 1; i >= 0; i--) if (typeof cur[i] === 'object') { segmentStart = i + 1; break }
  if (cur.slice(segmentStart).includes(raw)) return cur
  return pushTouchedCapped(cur, raw)
}

/** Append one item under the TOUCHED_DIRS_CAP. Eviction must NEVER take a {cd}
 * marker — dropping one corrupts the replay cursor for every later relative
 * touch — so the oldest touch (string) goes first; an all-marker state
 * degrades to oldest-first. */
function pushTouchedCapped(items: Array<string | { cd: string }>, item: string | { cd: string }): Array<string | { cd: string }> {
  const next = [...items, item]
  if (next.length <= TOUCHED_DIRS_CAP) return next
  const victim = next.findIndex(x => typeof x === 'string')
  next.splice(victim === -1 ? 0 : victim, 1)
  return next
}

/**
 * Register the touched-dirs projection on the official sessionProjections
 * service — inject-free `ctx.get` read (A3): lean hosts without the registry
 * keep cwd-only activation. The definition carries BOTH registry
 * generations' field names: newer hosts read `stateSchema` + host-only
 * `stateOf`; the published rc line reads `schema` + `view` through
 * `snapshot` (verified by registering a structural schema against the real
 * published registry — it validates only `stateVersion`).
 */
function registerTouchedDirsProjection(ctx: Context): void {
  const projections = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessionProjections') as
    | { register?: (definition: unknown) => unknown }
    | undefined
  if (projections === undefined || typeof projections.register !== 'function') return
  try {
    projections.register({
      key: TOUCHED_DIRS_KEY,
      stateVersion: 2, // v2: {cd} markers enable the touch-time cursor replay (P1/P2); ver=1 cache rows are discarded by the registry and refolded from the log
      stateSchema: touchedDirsSchema,
      schema: touchedDirsSchema,
      view: (state: unknown) => state,
      init: () => [],
      apply: foldTouchedDirs,
    })
  } catch {
    // registry present but contract drift: degrade to cwd-only activation
  }
}

/**
 * Read the touched-dirs state off whichever registry generation the host
 * runs: newer hosts expose `stateOf(session, key)`; the published rc line
 * only `snapshot(session)` (which covers every registered unit). Returns
 * undefined whenever neither path works — touch activation silently
 * degrades to the cwd chain.
 */
function readTouchedDirs(projections: unknown, session: unknown): unknown[] | undefined {
  const p = projections as {
    stateOf?: (session: unknown, key: string) => unknown
    snapshot?: (session: unknown) => { values?: Record<string, unknown> }
  } | undefined
  try {
    if (typeof p?.stateOf === 'function') {
      const v = p.stateOf(session, TOUCHED_DIRS_KEY)
      if (Array.isArray(v)) return v
    }
    if (typeof p?.snapshot === 'function') {
      const v = p.snapshot(session)?.values?.[TOUCHED_DIRS_KEY]
      if (Array.isArray(v)) return v
    }
  } catch {
    // registry present but failing: degrade to cwd-only activation
  }
  return undefined
}

/**
 * The session's EFFECTIVE cwd — the host workingDirectory service first
 * (it follows `working_directory cd`; absent on lean hosts), else undefined
 * so the caller's frozen-header fallback chain applies. Sync-only: safe
 * inside the systemPrompt text callback (`get` is sync; `ensure` is async
 * and belongs in tool execute paths only).
 */
function workingDirectoryCwd(ctx: Context, agent: unknown): string | undefined {
  const session = (agent as { session?: unknown } | undefined)?.session
  if (session === undefined) return undefined
  const wd = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workingDirectory') as
    | { get?: (s: unknown) => unknown }
    | undefined
  if (wd === undefined || typeof wd.get !== 'function') return undefined
  try {
    const v = wd.get(session)
    return typeof v === 'string' && v !== '' ? v : undefined
  } catch {
    return undefined // service present but failing: keep the frozen-header fallback
  }
}

/** Every sub-directory tag covering absDir up to (excluding) the project root; nothing when absDir IS the root or sits outside it. */
function dirTagChain(projRoot: string, absDir: string, into: Set<string>): void {
  const rel = path.relative(projRoot, absDir)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return
  const parts = rel.split(path.sep)
  for (let i = 1; i <= parts.length; i++) into.add(parts.slice(0, i).join('/'))
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
      const sessionCwd = workingDirectoryCwd(ctx, args?.agent) ?? sessionCwdOfAgent(args?.agent) ?? sessionCwdOfAgent(args?.scope) ?? extractSessionCwd(args?.scope) ?? process.cwd()
      const projectBase = projectBaseFor(sessionCwd) ?? scopeDir('project')
      // BUG B fix (v0.11.4): scope admission used the module-level
      // activeScopes(), so a host started from a guarded directory ($HOME,
      // /tmp) had NO project domain even though the session's workspace bucket
      // existed — saved memories never injected back. Admission now follows
      // the session-resolved base.
      const injectScopes: Array<'user' | 'project'> = projectBase === undefined ? ['user'] : ['user', 'project']
      const sections: string[] = []
      for (const scope of injectScopes) {
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
          // CLAUDE.md semantics (v0.13): root-level (untagged) project memories
          // always inject; a path tag injects when it names the effective cwd
          // itself or any of its ancestors (up to the project root), OR a
          // directory this session TOUCHED — via read/edit/write/grep/glob/
          // bash/pwsh tool calls — or one of that directory's ancestors. The
          // set is monotone: touched stays injected until the session ends.
          // The old over-inclusive rule (any tag DEEPER than the cwd injecting
          // too) is gone — deep tags now activate exactly when touched.
          const projRoot = path.resolve(base, '..', '..')
          const activeTags = new Set<string>()
          dirTagChain(projRoot, sessionCwd, activeTags)
          const agentSession = (args?.agent as { session?: unknown } | undefined)?.session
          if (agentSession !== undefined) {
            const touched = readTouchedDirs((ctx as unknown as { get?: (name: string) => unknown }).get?.('sessionProjections'), agentSession)
            if (touched !== undefined) {
              // P1/P2 fix: each relative touch resolves against the cursor AT ITS
              // TIME — start from the frozen creation cwd and advance through the
              // recorded working_directory cd markers — never against the
              // assembly-time cwd (that drops tags after a cd back, P1, and leaks
              // tags into never-touched areas after a cd forward, P2).
              let cursor = sessionCwdOfAgent(args?.agent) ?? sessionCwd
              for (const item of touched) {
                if (item !== null && typeof item === 'object') {
                  const cd = (item as { cd?: unknown }).cd
                  if (typeof cd === 'string' && cd.trim() !== '') cursor = path.isAbsolute(cd) ? cd : path.resolve(cursor, cd)
                  continue
                }
                if (typeof item !== 'string' || item.trim() === '') continue
                const abs = path.isAbsolute(item) ? item : path.resolve(cursor, item)
                // fold stores raw argument paths: read/edit/write/grep(file) hand us a FILE,
                // glob/grep(dir)/pwsh hand us a DIRECTORY. dirname alone strips the deepest
                // tag level for directory-shaped args; raw alone adds one unreachable tag
                // for file-shaped args (cwd is always a directory, so no saved memory can
                // ever carry a file-shaped tag). Feeding both covers every arg shape.
                dirTagChain(projRoot, abs, activeTags)
                dirTagChain(projRoot, path.dirname(abs), activeTags)
              }
            }
          }
          const matched: string[] = []
          for (const l of lines) {
            // path tag is anchored right after the (YYYY-MM-DD) date stamp —
            // brackets inside a title or excerpt can never be misread as a tag
            const m = /\(\d{4}-\d{2}-\d{2}\) \[([^\]]+)\]/.exec(l)
            if (m === null) { matched.push(l); continue } // no path tag = root-level
            if (activeTags.has(m[1]!)) matched.push(l)
            else hiddenElsewhere++
          }
          lines = matched
        }
        const shown = lines.slice(0, 25)
        const droppedByCap = lines.length - shown.length // B3: cap-dropped entries count too — nothing is silently hidden
        if (shown.length === 0 && hiddenElsewhere === 0 && droppedByCap === 0) continue
        const label = scope === 'user' ? 'User memories (cross-project, personal)' : 'Project memories (team-shared, filtered to your working area)'
        let sectionText = `### ${label}, newest first:\n` + shown.join('\n')
        if (hiddenElsewhere > 0 || droppedByCap > 0) {
          // Two-stage lazy loading (v0.7): nothing is silently hidden — the
          // index says how many memories exist outside the current working
          // area; memory_search surfaces them on demand, so context cost is
          // paid only when actually needed.
          const parts: string[] = []
          if (droppedByCap > 0) parts.push(`+${droppedByCap} older beyond the 25-line injection cap`)
          if (hiddenElsewhere > 0) parts.push(shown.length > 0
            ? `+${hiddenElsewhere} more tagged to areas you haven't touched`
            : `all ${hiddenElsewhere} memories in this project are tagged to areas you haven't touched`)
          const hint = `${parts.join('; ')} — memory_search surfaces them.`
          sectionText += (shown.length > 0 ? '\n' : '') + `(${hint})`
        }
        sections.push(sectionText)
      }
      if (sections.length === 0) return ''
      return '## Persistent memory (cross-session)\n'
        + sections.join('\n\n')
        + '\n\nUse memory_search / memory_read when prior context, user preferences, or earlier decisions may matter — before re-asking the user. '
        + 'Memory is not proof of current behavior — for consequential claims, inspect the actual owning source. '
        + 'memory_save only month-scale facts, at conclusions — never mid-progress state ("currently broken" is not a memory): preferences → "user"; project decisions/conventions → "project". '
        + 'The dated lines above show what already exists — the same feature/bug/investigation is one topic: update it in place instead of near-duplicating. '
        + 'Unsure whether durable → skip or ask the user; noise costs more than gaps. Never secrets or transient details.'
    },
  })
}

export async function apply(ctx: Context): Promise<void> {
  await refineWithWorkspaceRegistry(ctx)
  registerMemoryGuidance(ctx)
  registerTouchedDirsProjection(ctx)

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: SAVE_DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: 'Short title (max ~60 chars) shown in the index.' },
      content: { type: 'string', required: true, description: 'The memory itself. Self-contained plain text or markdown; will matter months later without this chat.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional topical tags for retrieval.' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'Where to store: "project" = team-shared decisions/conventions, committed to git (default inside a git repository); "user" = personal cross-project preferences (default outside a repo).' },
      path: { type: 'string', description: 'Optional sub-directory this memory belongs to (relative to project root, e.g. "frontend/src"). Auto-recorded from the session\'s effective working directory if omitted. Untagged (root-level) memories always inject; path-tagged memories inject once the session works in or touches (read/edit/write/grep/glob/shell calls) that area.' },
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
      // session cwd decides BOTH the default project scope and the path tag —
      // reads and writes now target the same per-session workspace bucket (the
      // rc1 read-only asymmetry is gone). v0.13: the cwd is the session's
      // EFFECTIVE directory (host workingDirectory service, which follows
      // `working_directory cd`) with the frozen session header as fallback.
      const agent = (exec as { agent?: unknown }).agent
      const sessionCwd = workingDirectoryCwd(ctx, agent) ?? sessionCwdOfAgent(agent)
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
      const scopes: Array<'user' | 'project'> = args.scope === undefined ? (projectBasesFor(ctx, exec).length > 0 ? ['user', 'project'] : ['user']) : [args.scope] // BUG B fix: admission follows session-resolved buckets
      const matches: Array<{ scope: string, id: string, title: string, excerpt: string, workspace?: string }> = []
      for (const scope of scopes) {
        // v0.11.1: the project scope follows the calling session's workspace
        // first, the service anchor second — the injection's "memory_search
        // surfaces them" promise holds in multi-workspace web hosts.
        const bases = scope === 'project' ? projectBasesFor(ctx, exec) : [scopeDir(scope)].filter((b): b is string => b !== undefined)
        for (const base of bases) {
        const dir = memoryDirOf(base)
        const files = (await fs.readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.md')).sort().reverse()
        for (const f of files) {
          if (matches.length >= limit) break
          if (f.toLowerCase().includes(lower)) {
            matches.push({ scope, id: f.replace(/\.md$/, ''), title: f.replace(/\.md$/, ''), excerpt: '(id match)', ...(scope === 'project' ? { workspace: path.resolve(base, '..', '..') } : {}) }) // B2: same entry shape as the content branch
            continue
          }
          const text = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '')
          if (text.toLowerCase().includes(lower)) {
            const titleLine = /^#\s+(.+)$/m.exec(text)?.[1] ?? f
            matches.push({ scope, id: f.replace(/\.md$/, ''), title: titleLine, excerpt: excerpt(text, q), ...(scope === 'project' ? { workspace: path.resolve(base, '..', '..') } : {}) }) // B2: model can tell which workspace a project hit came from
          }
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
      const safe = args.id.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '') // C7: allow underscore, matching the panel's charset
      // Field set mirrors Claude Code's shipped project_memory_read contract
      // (sdk-tools.d.ts): content?, local_file?, size_bytes, updated_at,
      // truncated — oversized memories return a truncated preview plus the
      // on-disk path instead of flooding the context window.
      for (const scope of ['project', 'user'] as const) {
        // v0.11.1: project reads try the calling session's workspace first,
        // then the service anchor — old memories stay readable.
        const bases = scope === 'project' ? projectBasesFor(ctx, exec) : [scopeDir(scope)].filter((b): b is string => b !== undefined)
        for (const base of bases) {
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
      const listScopes: Array<'user' | 'project'> = projectBasesFor(ctx, exec).length > 0 ? ['user', 'project'] : ['user'] // BUG B fix
      for (const scope of listScopes) {
        // v0.11.1: project lists merge the session workspace and the service
        // anchor (session first, id-deduped) so both stay visible.
        const bases = scope === 'project' ? projectBasesFor(ctx, exec) : [scopeDir(scope)].filter((b): b is string => b !== undefined)
        let all: string[] = []
        const seenIds = new Set<string>()
        for (const base of bases) {
          for (const line of await readIndex(base)) {
            const idMatch = /\(memories\/([^)]+)\)/.exec(line)?.[1]
            if (idMatch !== undefined && seenIds.has(idMatch)) continue
            if (idMatch !== undefined) seenIds.add(idMatch)
            all.push(line)
          }
        }
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
      kind: 'exact', // A2: host routes are {kind,path,handler}; method policing lives in the origin gate
      path: '/dsh-memory/api/v1/list',
      handler: async (request, response) => {
        if (!isTrustedPanelRequest(request, 'GET')) { refuseCrossOrigin(response); return }
        try {
          const payload = await buildPanelPayload(ctx)
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(payload))
        } catch {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: 'panel payload failed' }))
        }
      },
    })
    webServer.register({
      kind: 'exact', // A2
      path: '/dsh-memory/api/v1/save',
      handler: async (request, response) => {
        if (!isTrustedPanelRequest(request, 'POST')) { refuseCrossOrigin(response); return }
        await handlePanelSave(ctx, request, response)
      },
    })
    webServer.register({
      kind: 'exact', // A2
      path: '/dsh-memory/api/v1/delete',
      handler: async (request, response) => {
        if (!isTrustedPanelRequest(request, 'POST')) { refuseCrossOrigin(response); return }
        await handlePanelDelete(ctx, request, response)
      },
    })
    webServer.register({
      kind: 'exact', // A2
      path: '/dsh-memory/api/v1/update',
      handler: async (request, response) => {
        if (!isTrustedPanelRequest(request, 'POST')) { refuseCrossOrigin(response); return }
        await handlePanelUpdate(ctx, request, response)
      },
    })
    webServer.register({
      kind: 'exact', // A2
      path: '/dsh-memory/api/v1/read',
      handler: async (request, response) => {
        if (!isTrustedPanelRequest(request, 'POST')) { refuseCrossOrigin(response); return }
        await handlePanelRead(ctx, request, response)
      },
    })
  })
}
