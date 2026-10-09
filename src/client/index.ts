/**
 * dsh-memory client: registers the "Memory" section inside Settings — the P2.1
 * panel: expandable per-workspace tree with per-scope inline add buttons,
 * path (sub-folder) grouping inside each workspace, per-entry delete, and a
 * scrollable list. All writes go through the same save/delete cores as the
 * model tools.
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
  root: string, name: string, current: boolean, nested?: boolean,
  stats: ScopeStats, entries: PanelEntry[],
}

interface PanelData { scopes: { user?: ScopeInfo, projects?: WorkspaceInfo[] } }

interface SaveTarget { scope: 'user' | 'project', workspace?: string }

const S: Record<string, Partial<CSSStyleDeclaration>> = {
  pad: { padding: '16px', fontFamily: 'inherit' },
  h2: { margin: '0 0 12px' },
  toolbar: { display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' },
  section: { marginBottom: '16px' },
  muted: { color: 'var(--fg-muted, #888)', fontSize: '12px' },
  input: { padding: '6px 10px', boxSizing: 'border-box', fontFamily: 'inherit' },
  search: { width: '100%', maxWidth: '420px', padding: '6px 10px', boxSizing: 'border-box', fontFamily: 'inherit' },
  textarea: { width: '100%', padding: '6px 10px', boxSizing: 'border-box', fontFamily: 'inherit' },
  button: { padding: '4px 10px', fontFamily: 'inherit', cursor: 'pointer' },
  smallButton: { padding: '2px 8px', fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border, #e5e5e5)', borderRadius: '4px' },
  form: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px', maxWidth: '560px' },
  list: { listStyle: 'none', margin: '0', padding: '0' },
  item: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', padding: '8px 0', borderBottom: '1px solid var(--border, #e5e5e5)' },
  itemMain: { minWidth: '0', flex: '1' }, // span the full row so the title-row spacer can pin the buttons right
  tag: { margin: '0 4px', padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-muted, #f2f2f2)', fontSize: '11px' },
  wsHeader: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '6px 0', userSelect: 'none' },
  wsHeaderMain: { display: 'flex', alignItems: 'center', gap: '8px', flex: '1', minWidth: '0' },
  chevron: { display: 'inline-block', width: '1em', transition: 'transform 120ms' },
  current: { margin: '0', padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-accent, #e0ecff)', fontSize: '11px' },
  titleRow: { display: 'flex', alignItems: 'baseline', gap: '4px', flexWrap: 'nowrap' },
  pathGroup: { marginLeft: '18px', borderLeft: '1px solid var(--border, #e5e5e5)', paddingLeft: '10px', marginTop: '4px' },
  pathHeader: { color: 'var(--fg-muted, #888)', fontSize: '12px', padding: '4px 0' },
  scroller: { maxHeight: '60vh', overflowY: 'auto', paddingRight: '8px' },
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

function gauge(stats: ScopeStats): string {
  return `${stats.entries}/${stats.maxEntries} lines · ${(stats.indexBytes / 1024).toFixed(1)}/${(stats.maxBytes / 1024).toFixed(0)} KB · ${stats.memoryFiles}/${stats.maxMemories} files`
}

function MemoryPanel(): ReactElement {
  const [data, setData] = useState<PanelData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
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
    ),
    h('div', { style: S.scroller },
      h(UserSection, {
        info: data.scopes.user, query: q,
        onSaved: fetchList,
      }),
      workspaces.length > 0 ? h('h3', { style: { margin: '8px 0 4px' } }, 'Projects') : null,
      workspaces.map(ws => h(WorkspaceSection, {
        key: ws.root,
        ws,
        query: q,
        open: searchActive || expanded.has(ws.root),
        onToggle: () => {
          const next = new Set(expanded)
          if (next.has(ws.root)) next.delete(ws.root)
          else next.add(ws.root)
          setExpanded(next)
        },
        onSaved: fetchList,
      })),
    ),
  )
}

/** Entries grouped by sub-folder path: root-level first, then path groups. */
function GroupedEntries(props: { entries: PanelEntry[], query: string, emptyText: string, target: SaveTarget, onSaved: () => void }): ReactElement {
  const { entries, query, target, onSaved } = props
  const q = query
  const matched = q === '' ? entries : entries.filter(e => entryMatches(e, q))
  const root = matched.filter(e => e.path === '')
  const groups = new Map<string, PanelEntry[]>()
  for (const e of matched) {
    if (e.path === '') continue
    const list = groups.get(e.path) ?? []
    list.push(e)
    groups.set(e.path, list)
  }
  if (matched.length === 0) return h('p', { style: S.muted }, q === '' ? props.emptyText : 'No memories match the search.')
  return h('div', null,
    h(EntryList, { entries: root, query: '', target, onSaved }),
    [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, es]) =>
      h('div', { key: p, style: S.pathGroup },
        h('div', { style: S.pathHeader }, '📁 ', p, ` · ${es.length}`),
        h(EntryList, { entries: es, query: '', target, onSaved }),
      )),
  )
}

function EntryList(props: { entries: PanelEntry[], query: string, target: SaveTarget, onSaved: () => void }): ReactElement {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const del = (e: PanelEntry): void => {
    if (deleting !== null || e.id === undefined) return
    if (!window.confirm(`Delete "${e.title}"?`)) return
    setDeleting(e.id)
    setRowError(null)
    fetch('/dsh-memory/api/v1/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: props.target.scope, workspace: props.target.workspace, id: e.id }),
    })
      .then(async r => {
        const d = r.json() as Promise<{ ok?: boolean, error?: string }>
        if (!r.ok || (await d).ok !== true) throw new Error((await d as { error?: string }).error ?? `HTTP ${r.status}`)
        props.onSaved()
      })
      .catch(err => { setRowError(`Delete failed: ${String(err)}`) }) // surface, never swallow
      .finally(() => { setDeleting(null) })
  }
  if (props.entries.length === 0) return h('span')
  return h('ul', { style: S.list },
    rowError !== null ? h('li', { key: 'error', style: S.item }, h('div', { style: S.error }, rowError)) : null,
    props.entries.map((e, i) => {
      if (e.id !== undefined && editing === e.id) {
        // block layout: the form must span the full row like the add form,
        // not shrink as a flex child of the entry row style
        return h('li', { key: e.id, style: { ...S.item, display: 'block' } },
          h(MemoryForm, { target: props.target, initial: e, onDone: () => { setEditing(null); props.onSaved() } }))
      }
      return h('li', { key: e.id ?? i, style: S.item },
        h('div', { style: S.itemMain },
          h('div', { style: S.titleRow },
            h('strong', null, e.title),
            e.tags.map(t => h('code', { key: t, style: S.tag }, t)),
            h('span', { style: { flex: '1', minWidth: '8px' } }),
            e.id !== undefined
              ? h('button', { style: S.smallButton, title: 'Edit this memory', onClick: () => { setEditing(e.id!); setRowError(null) } }, '✎')
              : null,
            e.id !== undefined
              ? h('button', { style: S.smallButton, title: 'Delete this memory', disabled: deleting === e.id, onClick: () => del(e) }, deleting === e.id ? '…' : '×')
              : null,
          ),
          h('div', { style: S.muted }, e.date !== '' ? `${e.date} — ` : '', e.excerpt),
        ),
      )
    }),
  )
}

/** Inline edit form: fetches the full text on demand, saves via /update. */
/** One form, two modes — add (empty, /save) and edit (prefilled via /read, /update). Identical layout and size. */
function MemoryForm(props: { target: SaveTarget, initial?: PanelEntry, onDone: () => void }): ReactElement {
  const editing = props.initial !== undefined && props.initial.id !== undefined
  const [title, setTitle] = useState(props.initial?.title ?? '')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState(props.initial?.tags.join(', ') ?? '')
  const [loading, setLoading] = useState(editing)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!editing) return
    fetch('/dsh-memory/api/v1/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: props.target.scope, workspace: props.target.workspace, id: props.initial!.id }),
    })
      .then(async r => {
        const d = r.json() as Promise<{ ok?: boolean, error?: string, content?: string }>
        if (!r.ok || (await d).ok !== true) throw new Error((await d as { error?: string }).error ?? `HTTP ${r.status}`)
        return d
      })
      .then(d => { setContent(d.content ?? '') })
      .catch(err => { setFormError(String(err)) })
      .finally(() => { setLoading(false) })
  }, [])
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setFormError(null)
    const tagList = tags.split(',').map(t => t.trim()).filter(t => t !== '')
    fetch(editing ? '/dsh-memory/api/v1/update' : '/dsh-memory/api/v1/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(editing
        ? { scope: props.target.scope, workspace: props.target.workspace, id: props.initial!.id, title, content, tags: tagList }
        : { scope: props.target.scope, workspace: props.target.workspace, title, content, tags: tagList }),
    })
      .then(async r => {
        const d = r.json() as Promise<{ ok?: boolean, error?: string }>
        if (!r.ok || (await d).ok !== true) throw new Error((await d as { error?: string }).error ?? `HTTP ${r.status}`)
        props.onDone()
      })
      .catch(err => { setFormError(String(err)); setSaving(false) })
  }
  if (loading && formError === null) return h('div', { style: S.form }, 'Loading…')
  return h('form', { style: S.form, onSubmit: submit },
    h('input', { style: S.input, placeholder: 'Title (max 60 chars)', value: title, maxLength: 60, autoFocus: true, onChange: (e: ChangeEvent<HTMLInputElement>) => setTitle(e.target.value) }),
    h('textarea', { style: S.textarea, placeholder: 'The memory itself — self-contained, will matter months later', value: content, rows: 4, onChange: (e: ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value) }),
    h('input', { style: S.input, placeholder: 'Tags, comma-separated (optional)', value: tags, onChange: (e: ChangeEvent<HTMLInputElement>) => setTags(e.target.value) }),
    formError !== null ? h('div', { style: S.error }, formError) : null,
    h('div', null,
      h('button', { style: S.button, type: 'submit', disabled: saving || title.trim() === '' || content.trim() === '' }, saving ? 'Saving…' : editing ? 'Save changes' : 'Save memory'),
      editing ? h('button', { style: { ...S.button, marginLeft: '8px' }, type: 'button', onClick: props.onDone }, 'Cancel') : null,
    ),
  )
}

function UserSection(props: { info: ScopeInfo | undefined, query: string, onSaved: () => void }): ReactElement {
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState(true)
  const { info, query } = props
  const target: SaveTarget = { scope: 'user' }
  return h('section', { style: S.section },
    h('div', { style: S.wsHeader },
      h('div', { style: S.wsHeaderMain, onClick: () => { setOpen(!open) } },
        h('span', { style: { ...S.chevron, transform: open ? 'rotate(90deg)' : 'rotate(0deg)' } }, '▸'),
        h('strong', null, 'User'),
        h('span', { style: S.muted }, info?.available === true ? gauge(info.stats!) : ''),
      ),
      h('button', { style: S.smallButton, title: 'Add a user memory', onClick: () => { setAdding(!adding) } }, adding ? '×' : '+'),
    ),
    open ? h('div', null,
      adding ? h(MemoryForm, { target, onDone: () => { setAdding(false); props.onSaved() } }) : null,
      info?.available !== true
        ? h('p', { style: S.muted }, 'Not available in this workspace')
        : h(GroupedEntries, { entries: info.entries ?? [], query, emptyText: 'No memories yet.', target, onSaved: props.onSaved }),
    ) : null,
  )
}

function WorkspaceSection(props: { ws: WorkspaceInfo, query: string, open: boolean, onToggle: () => void, onSaved: () => void }): ReactElement {
  const [adding, setAdding] = useState(false)
  const { ws, open, onToggle } = props
  const target: SaveTarget = { scope: 'project', workspace: ws.root }
  return h('section', { style: S.section },
    h('div', { style: S.wsHeader },
      h('div', { style: S.wsHeaderMain, onClick: onToggle },
        h('span', { style: { ...S.chevron, transform: open ? 'rotate(90deg)' : 'rotate(0deg)' } }, '▸'),
        h('strong', null, ws.name),
        ws.current ? h('code', { style: S.current }, 'current') : null,
        ws.nested === true ? h('code', { style: S.current }, 'sub') : null,
        h('span', { style: S.muted }, `${ws.entries.length} memories · ${gauge(ws.stats)}`),
      ),
      h('button', { style: S.smallButton, title: `Add a memory in ${ws.name}`, onClick: () => setAdding(!adding) }, adding ? '×' : '+'),
    ),
    open ? h('div', null,
      adding ? h(MemoryForm, { target, onDone: () => { setAdding(false); props.onSaved() } }) : null,
      h(GroupedEntries, { entries: ws.entries, query: props.query, emptyText: 'No memories in this workspace.', target, onSaved: props.onSaved }),
    ) : null,
  )
}
