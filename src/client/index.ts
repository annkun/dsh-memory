/**
 * dsh-memory client: registers a "Memory" tab inside the Plugins settings
 * section — the P1 read-only panel (two-scope list, search, guard gauges).
 * Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js;
 * the only externals are the loader module table's react entries.
 */
import { createElement as h, useState, useEffect } from 'react'
import type { ChangeEvent, ReactElement } from 'react'

interface ClientSlotContext {
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, render: () => unknown): unknown
  }
}

interface PanelEntry {
  id?: string
  title: string
  date: string
  path: string
  tags: string[]
  excerpt: string
}

interface ScopeInfo {
  available: boolean
  stats?: {
    entries: number, maxEntries: number,
    indexBytes: number, maxBytes: number,
    memoryFiles: number, maxMemories: number,
  }
  entries?: PanelEntry[]
}

interface PanelData { scopes: { user?: ScopeInfo, project?: ScopeInfo } }

const SCOPE_LABELS: Record<string, string> = {
  project: 'Project (team-shared, committed to the repo)',
  user: 'User (personal, cross-project)',
}

const S: Record<string, Partial<CSSStyleDeclaration>> = {
  pad: { padding: '16px', fontFamily: 'inherit' },
  h2: { margin: '0 0 12px' },
  section: { marginBottom: '20px' },
  muted: { color: 'var(--fg-muted, #888)', fontSize: '12px' },
  input: { width: '100%', maxWidth: '420px', padding: '6px 10px', marginBottom: '12px', boxSizing: 'border-box' },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  item: { padding: '8px 0', borderBottom: '1px solid var(--border, #e5e5e5)' },
  tag: { margin: '0 4px', padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-muted, #f2f2f2)', fontSize: '11px' },
}

export const name = '@fooxe/dsh-memory'
export const inject = ['slots']

export function apply(ctx: ClientSlotContext): void {
  // The Plugins settings section's tab slot: "one page inside the Plugins
  // settings section", rendered as a tab beside the host's own. A host that
  // does not declare this slot never runs this registration (clean downgrade).
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'dsh-memory',
    order: 70,
    label: () => 'Memory',
    locale: 'dsh-memory',
  }, () => h(MemoryPanel)))
}

function MemoryPanel(): ReactElement {
  const [data, setData] = useState<PanelData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    fetch('/dsh-memory/api/v1/list')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<PanelData> })
      .then(setData)
      .catch(e => setError(String(e)))
  }, [])
  if (error !== null) return h('div', { style: S.pad }, `Failed to load memories: ${error}`)
  if (data === null) return h('div', { style: S.pad }, 'Loading…')
  return h('div', { style: S.pad },
    h('h2', { style: S.h2 }, 'Memory'),
    h('input', {
      style: S.input,
      placeholder: 'Search memories…',
      value: query,
      onChange: (e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    }),
    (['project', 'user'] as const).map(scope =>
      h(ScopeSection, { key: scope, scope, info: data.scopes[scope], query })),
  )
}

function ScopeSection(props: { scope: string, info: ScopeInfo | undefined, query: string }): ReactElement {
  const { scope, info, query } = props
  const label = SCOPE_LABELS[scope] ?? scope
  if (info?.available !== true) {
    return h('section', { style: S.section },
      h('h3', null, label),
      h('p', { style: S.muted }, 'Not available in this workspace'))
  }
  const q = query.trim().toLowerCase()
  const entries = (info.entries ?? []).filter(e =>
    q === '' ||
    e.title.toLowerCase().includes(q) ||
    e.excerpt.toLowerCase().includes(q) ||
    e.path.toLowerCase().includes(q) ||
    e.tags.some(t => t.toLowerCase().includes(q)))
  const stats = info.stats!
  const gauge = `${stats.entries}/${stats.maxEntries} lines · ${(stats.indexBytes / 1024).toFixed(1)}/${(stats.maxBytes / 1024).toFixed(0)} KB · ${stats.memoryFiles}/${stats.maxMemories} files`
  return h('section', { style: S.section },
    h('h3', null, label, ' ', h('span', { style: S.muted }, gauge)),
    entries.length === 0
      ? h('p', { style: S.muted }, q === '' ? 'No memories yet.' : 'No memories match the search.')
      : h('ul', { style: S.list }, entries.map((e, i) => h('li', { key: e.id ?? i, style: S.item },
          h('div', null,
            h('strong', null, e.title),
            e.path !== '' ? h('code', { key: 'path', style: S.tag }, e.path) : null,
            ...e.tags.map(t => h('code', { key: t, style: S.tag }, t))),
          h('div', { style: S.muted }, e.date !== '' ? `${e.date} — ` : '', e.excerpt),
        ))),
  )
}
