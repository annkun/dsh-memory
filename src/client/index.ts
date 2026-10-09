/**
 * dsh-memory client: registers the "Memory" section inside Settings — the P2
 * panel: expandable per-workspace groups, cross-scope search, and an in-panel
 * add form writing through the same save core as the model tool.
 * Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js;
 * the only externals are the loader module table's react entries.
 */
import { createElement as h, useState, useEffect, useCallback } from 'react'
import type { ChangeEvent, FormEvent, ReactElement } from 'react'

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

interface ScopeStats {
  entries: number, maxEntries: number,
  indexBytes: number, maxBytes: number,
  memoryFiles: number, maxMemories: number,
}

interface ScopeInfo { available: boolean, stats?: ScopeStats, entries?: PanelEntry[] }

interface WorkspaceInfo {
  root: string, name: string, current: boolean,
  stats: ScopeStats, entries: PanelEntry[],
}

interface PanelData { scopes: { user?: ScopeInfo, projects?: WorkspaceInfo[] } }

const S: Record<string, Partial<CSSStyleDeclaration>> = {
  pad: { padding: '16px', fontFamily: 'inherit' },
  h2: { margin: '0 0 12px' },
  toolbar: { display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' },
  section: { marginBottom: '20px' },
  muted: { color: 'var(--fg-muted, #888)', fontSize: '12px' },
  input: { padding: '6px 10px', boxSizing: 'border-box', fontFamily: 'inherit' },
  search: { width: '100%', maxWidth: '420px', padding: '6px 10px', boxSizing: 'border-box', fontFamily: 'inherit' },
  textarea: { width: '100%', padding: '6px 10px', boxSizing: 'border-box', fontFamily: 'inherit' },
  button: { padding: '6px 14px', fontFamily: 'inherit', cursor: 'pointer' },
  form: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', maxWidth: '560px' },
  list: { listStyle: 'none', margin: '0', padding: '0' },
  item: { padding: '8px 0', borderBottom: '1px solid var(--border, #e5e5e5)' },
  tag: { margin: '0 4px', padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-muted, #f2f2f2)', fontSize: '11px' },
  wsHeader: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '6px 0', userSelect: 'none' },
  chevron: { display: 'inline-block', width: '1em', transition: 'transform 120ms' },
  current: { margin: '0', padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-accent, #e0ecff)', fontSize: '11px' },
  error: { color: 'var(--fg-danger, #c33)', fontSize: '13px' },
}

export const name = '@fooxe/dsh-memory'
export const inject = ['slots']

export function apply(ctx: ClientSlotContext): void {
  // The settings shell's per-feature page slot (ui-settings contract):
  // one nav entry + one panel page per registration. A host without this
  // slot never runs the registration (clean downgrade).
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-memory',
    order: 70,
    label: () => 'Memory',
    locale: 'dsh-memory',
  }, () => h(MemoryPanel)))
}

function entryMatches(e: PanelEntry, q: string): boolean {
  return e.title.toLowerCase().includes(q)
    || e.excerpt.toLowerCase().includes(q)
    || e.path.toLowerCase().includes(q)
    || e.tags.some(t => t.toLowerCase().includes(q))
}

function MemoryPanel(): ReactElement {
  const [data, setData] = useState<PanelData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [defaultExpanded, setDefaultExpanded] = useState(false)

  const fetchList = useCallback(() => {
    fetch('/dsh-memory/api/v1/list')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<PanelData> })
      .then(d => { setData(d); setError(null) })
      .catch(e => setError(String(e)))
  }, [])

  useEffect(() => { fetchList() }, [fetchList])

  if (error !== null) return h('div', { style: S.pad }, `Failed to load memories: ${error}`)
  if (data === null) return h('div', { style: S.pad }, 'Loading…')

  const workspaces = data.scopes.projects ?? []
  if (!defaultExpanded) {
    // first paint: expand the current workspace only
    setDefaultExpanded(true)
    setExpanded(new Set(workspaces.filter(w => w.current).map(w => w.root)))
  }

  const q = query.trim().toLowerCase()
  const searchActive = q !== ''

  return h('div', { style: S.pad },
    h('h2', { style: S.h2 }, 'Memory'),
    h('div', { style: S.toolbar },
      h('input', {
        style: S.search,
        placeholder: 'Search memories…',
        value: query,
        onChange: (e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
      }),
      h('button', { style: S.button, onClick: () => setAdding(!adding) }, adding ? '× Cancel' : '+ Add'),
    ),
    adding ? h(AddForm, {
      workspaces,
      onDone: () => { setAdding(false); fetchList() },
    }) : null,
    h(UserSection, { info: data.scopes.user, query: q }),
    workspaces.length > 0
      ? h('h3', { style: { margin: '16px 0 4px' } }, 'Projects')
      : null,
    workspaces.map(ws => h(WorkspaceSection, {
      key: ws.root,
      ws,
      query: q,
      forceOpen: searchActive,
      open: searchActive || expanded.has(ws.root),
      onToggle: () => {
        const next = new Set(expanded)
        if (next.has(ws.root)) next.delete(ws.root)
        else next.add(ws.root)
        setExpanded(next)
      },
    })),
  )
}

function gauge(stats: ScopeStats): string {
  return `${stats.entries}/${stats.maxEntries} lines · ${(stats.indexBytes / 1024).toFixed(1)}/${(stats.maxBytes / 1024).toFixed(0)} KB · ${stats.memoryFiles}/${stats.maxMemories} files`
}

function EntryList(props: { entries: PanelEntry[], query: string, emptyText: string }): ReactElement {
  const q = props.query
  const entries = q === '' ? props.entries : props.entries.filter(e => entryMatches(e, q))
  if (entries.length === 0) return h('p', { style: S.muted }, q === '' ? props.emptyText : 'No memories match the search.')
  return h('ul', { style: S.list }, entries.map((e, i) => h('li', { key: e.id ?? i, style: S.item },
    h('div', null,
      h('strong', null, e.title),
      e.path !== '' ? h('code', { key: 'path', style: S.tag }, e.path) : null,
      ...e.tags.map(t => h('code', { key: t, style: S.tag }, t))),
    h('div', { style: S.muted }, e.date !== '' ? `${e.date} — ` : '', e.excerpt),
  )))
}

function UserSection(props: { info: ScopeInfo | undefined, query: string }): ReactElement {
  const { info, query } = props
  if (info?.available !== true) return h('section', { style: S.section },
    h('h3', null, 'User'), h('p', { style: S.muted }, 'Not available in this workspace'))
  return h('section', { style: S.section },
    h('h3', null, 'User ', h('span', { style: S.muted }, gauge(info.stats!))),
    h('p', { style: { ...S.muted, margin: '0 0 4px' } }, 'Personal, cross-project'),
    h(EntryList, { entries: info.entries ?? [], query, emptyText: 'No memories yet.' }),
  )
}

function WorkspaceSection(props: { ws: WorkspaceInfo, query: string, open: boolean, forceOpen: boolean, onToggle: () => void }): ReactElement {
  const { ws, open, onToggle } = props
  return h('section', { style: S.section },
    h('div', { style: S.wsHeader, onClick: props.forceOpen ? undefined : onToggle },
      h('span', { style: { ...S.chevron, transform: open ? 'rotate(90deg)' : 'rotate(0deg)' } }, '▸'),
      h('strong', null, ws.name),
      ws.current ? h('code', { style: S.current }, 'current') : null,
      h('span', { style: S.muted }, `${ws.entries.length} memories · ${gauge(ws.stats)}`),
    ),
    open ? h(EntryList, { entries: ws.entries, query: props.query, emptyText: 'No memories in this workspace.' }) : null,
  )
}

function AddForm(props: { workspaces: WorkspaceInfo[], onDone: () => void }): ReactElement {
  const [scope, setScope] = useState<string>(props.workspaces.find(w => w.current)?.root ?? 'user')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setFormError(null)
    const body = {
      scope: scope === 'user' ? 'user' : 'project',
      workspace: scope === 'user' ? undefined : scope,
      title, content,
      tags: tags.split(',').map(t => t.trim()).filter(t => t !== ''),
    }
    fetch('/dsh-memory/api/v1/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async r => {
        const data = r.json() as Promise<{ ok?: boolean, error?: string }>
        if (!r.ok || (await data).ok !== true) throw new Error((await data as { error?: string }).error ?? `HTTP ${r.status}`)
        props.onDone()
      })
      .catch(err => { setFormError(String(err)); setSaving(false) })
  }

  return h('form', { style: S.form, onSubmit: submit },
    h('select', {
      style: S.input, value: scope,
      onChange: (e: ChangeEvent<HTMLSelectElement>) => setScope(e.target.value),
    },
      h('option', { key: 'user', value: 'user' }, 'User — personal, cross-project'),
      ...props.workspaces.map(w => h('option', { key: w.root, value: w.root }, `${w.name}${w.current ? ' (current)' : ''} — team-shared`)),
    ),
    h('input', { style: S.input, placeholder: 'Title (max 60 chars)', value: title, maxLength: 60, onChange: (e: ChangeEvent<HTMLInputElement>) => setTitle(e.target.value) }),
    h('textarea', { style: S.textarea, placeholder: 'The memory itself — self-contained, will matter months later', value: content, rows: 4, onChange: (e: ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value) }),
    h('input', { style: S.input, placeholder: 'Tags, comma-separated (optional)', value: tags, onChange: (e: ChangeEvent<HTMLInputElement>) => setTags(e.target.value) }),
    formError !== null ? h('div', { style: S.error }, formError) : null,
    h('div', null,
      h('button', { style: S.button, type: 'submit', disabled: saving || title.trim() === '' || content.trim() === '' }, saving ? 'Saving…' : 'Save memory'),
    ),
  )
}
