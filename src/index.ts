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

import { promises as fs, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plugin name registered with the Loader. */
export const name = 'dsh-memory'

/** Host services this plugin consumes. */
export const inject = ['tools']

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

async function ensureDirs(base: string): Promise<void> {
  await fs.mkdir(memoryDirOf(base), { recursive: true })
}

async function readIndex(base: string): Promise<string[]> {
  try {
    const text = await fs.readFile(indexFileOf(base), 'utf8')
    return text.split('\n').filter(line => line.startsWith('- '))
  } catch {
    return []
  }
}

/** Write one scope's index with both guards applied; returns the kept line count. */
async function writeIndexGuarded(base: string, lines: string[]): Promise<number> {
  let kept = lines.slice(0, MAX_INDEX_LINES)
  while (kept.join('\n').length > MAX_INDEX_BYTES && kept.length > 1) {
    kept = kept.slice(0, kept.length - 1) // drop oldest (last) entries
  }
  await ensureDirs(base)
  await fs.writeFile(indexFileOf(base), INDEX_HEADER + kept.join('\n') + '\n', 'utf8')
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

function excerpt(text: string, query: string, radius = 60): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return text.slice(0, radius * 2).trim()
  const start = Math.max(0, at - radius)
  return (start > 0 ? '…' : '') + text.slice(start, at + query.length + radius).trim() + (at + query.length + radius < text.length ? '…' : '')
}

const SAVE_DESCRIPTION = [
  'Save a durable memory that persists across sessions. Proactively call this whenever the conversation reveals information worth remembering long-term:',
  "the user's preferences, working habits, or corrections; project decisions and their rationale; key facts, numbers, or IDs; task outcomes and lessons learned.",
  'Do not save secrets (tokens, passwords) or transient details. Prefer several small focused memories over one large one. Scope rule: personal cross-project preferences go to scope "user"; project decisions and conventions go to scope "project" (team-shared, committed to git).',
].join(' ')

const SEARCH_DESCRIPTION = 'Search saved memories by keyword (case-insensitive substring match across titles, tags, and content). Call this when prior context, user preferences, or earlier decisions may be relevant to the current task — before re-asking the user.'

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

function registerMemoryGuidance(ctx: Context): void {
  const systemPrompt = (ctx as unknown as { systemPrompt?: SystemPromptService }).systemPrompt
  if (systemPrompt === undefined) return // host composition has no systemPrompt service
  let order: number | undefined
  try {
    order = systemPrompt.getSectionOrder('TOOLS')
  } catch {
    order = undefined
  }
  systemPrompt.section({
    name: 'dsh-memory:auto',
    ...(order === undefined ? {} : { order }),
    text: () => {
      const sections: string[] = []
      for (const scope of activeScopes()) {
        const base = scopeDir(scope)
        if (base === undefined) continue
        let index = ''
        try {
          index = readFileSync(indexFileOf(base), 'utf8')
        } catch {
          continue // nothing remembered in this scope yet
        }
        const lines = index.split('\n').filter(l => l.startsWith('- ')).slice(0, 25)
        if (lines.length === 0) continue
        const label = scope === 'user' ? 'User memories (cross-project, personal)' : 'Project memories (team-shared)'
        sections.push(`### ${label}, newest first:\n` + lines.join('\n'))
      }
      if (sections.length === 0) return ''
      return '## Persistent memory (cross-session)\n'
        + sections.join('\n\n')
        + '\n\nUse memory_search / memory_read when prior context, user preferences, or earlier decisions may matter — before re-asking the user. '
        + 'Proactively memory_save important new facts as they appear: personal preferences → scope "user"; project decisions/conventions → scope "project". Never save secrets or transient details.'
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
    },
    output: {
      // Loose object schema: execute returns either the success value or a
      // {code,message} domain-error value (both are valid canonical values).
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { title: string, content: string, tags?: string[], scope?: 'user' | 'project' }, exec) {
      if (exec.signal.aborted) return simpleError('aborted', 'Save aborted before completion.')
      const title = args.title.trim().slice(0, 60)
      const content = args.content.trim().slice(0, MAX_CONTENT_CHARS)
      if (!title || !content) return simpleError('invalid_input', 'title and content must be non-empty.')
      let scope = args.scope
      if (scope === undefined) scope = PROJECT_DIR === undefined ? 'user' : 'project'
      const base = scopeDir(scope)
      if (base === undefined) return simpleError('no_project_scope', 'No git repository detected here; only the "user" scope is available.')
      const now = new Date()
      const id = `${timestamp(now)}-${slugify(title)}`
      const file = path.join(memoryDirOf(base), `${id}.md`)
      const header = `---\nid: ${id}\nscope: ${scope}\nsaved_at: ${now.toISOString()}\ntags: ${(args.tags ?? []).join(', ')}\n---\n\n# ${title}\n\n`
      await ensureDirs(base)
      await fs.writeFile(file, header + content + '\n', 'utf8')
      const tagSuffix = args.tags?.length ? ` \`${args.tags.join('\` \`')}\`` : ''
      const lines = await readIndex(base)
      lines.unshift(`- [${title}](memories/${id}.md) — ${content.split('\n')[0]!.slice(0, 80)}${tagSuffix}`)
      const kept = await writeIndexGuarded(base, lines)
      const pruned = await pruneMemories(base)
      return {
        id, scope, file, saved: true,
        indexEntries: kept, prunedMemories: pruned,
        notice: `Saved 1 ${scope} memory (${scope === 'project' ? 'team-shared, commit it to git' : 'personal, cross-project'}). Index now lists ${kept} entries.`,
      }
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
}
