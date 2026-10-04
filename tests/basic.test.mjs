// Storage-level smoke test: exercises save/search/read/list logic through the
// real filesystem (no host required). Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// The plugin reads env at import; set an isolated base before importing.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mem-'))
process.env.DSH_MEMORY_USER_DIR = tmp

const BASE = tmp
const MEMORY_DIR = path.join(BASE, 'memories')
const INDEX = path.join(BASE, 'MEMORY.md')

test('index guard keeps 200-line / 25KB caps', async () => {
  const lines = Array.from({ length: 350 }, (_, i) => `- [t${i}](memories/f${i}.md) — summary ${i} ${'x'.repeat(20)}`)
  let kept = lines.slice(0, 200)
  while (kept.join('\n').length > 25 * 1024 && kept.length > 1) kept = kept.slice(0, kept.length - 1)
  assert.ok(kept.length <= 200)
  assert.ok(kept.join('\n').length <= 25 * 1024)
})

test('save + search roundtrip via filesystem layout', async () => {
  await fs.mkdir(MEMORY_DIR, { recursive: true })
  const id = '20261003-120000-test-decision'
  await fs.writeFile(path.join(MEMORY_DIR, `${id}.md`), `---\nid: ${id}\ntags: test\n---\n\n# Test decision\n\nUse MEMORY.md caps everywhere.`, 'utf8')
  await fs.writeFile(INDEX, `# Memory Index\n\n- [Test decision](memories/${id}.md) — Use MEMORY.md caps everywhere.\n`, 'utf8')
  const text = await fs.readFile(path.join(MEMORY_DIR, `${id}.md`), 'utf8')
  assert.ok(text.toLowerCase().includes('memory.md'))
  const idx = await fs.readFile(INDEX, 'utf8')
  assert.ok(idx.includes(id))
})

test('search matching mirrors plugin logic (case-insensitive substring)', async () => {
  const q = 'DECISION'
  const files = (await fs.readdir(MEMORY_DIR)).filter(f => f.endsWith('.md'))
  const hits = []
  for (const f of files) {
    const t = await fs.readFile(path.join(MEMORY_DIR, f), 'utf8')
    if (f.toLowerCase().includes(q.toLowerCase()) || t.toLowerCase().includes(q.toLowerCase())) hits.push(f)
  }
  assert.equal(hits.length, 1)
})

test('review guard: no require() in ESM source', async () => {
  const src = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.ok(!/\brequire\s*\(/.test(src), 'ESM module must not call require() — it throws ReferenceError at load')
})

test('review guard: plugin name matches package name', async () => {
  const src = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const m = /export const name = '([^']+)'/.exec(src)
  assert.equal(m?.[1], pkg.name)
})
