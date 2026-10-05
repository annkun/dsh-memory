// 边界修复回归（v0.7.1）：
// 1) 同前缀兄弟目录（myproj vs myproj0）不得误判为项目内 → 不产生 [../x] 垃圾标签
// 2) 摘要含 ASCII 方括号 → 不误判为路径标签，根级记忆照常注入
// 3) 索引 25KB 上限按 UTF-8 字节计（中文 3 字节/字符，不再 3 倍超限）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-edge-'))
const proj = path.join(tmp, 'myproj')
const sibling = path.join(tmp, 'myproj0') // 同前缀兄弟目录，在项目外
await fs.mkdir(sibling, { recursive: true })
process.env.DSH_MEMORY_USER_DIR = path.join(tmp, 'user')
process.env.DSH_MEMORY_PROJECT_DIR = proj // 环境变量直指项目根（最显式优先级）
process.chdir(sibling) // 会话开在兄弟目录

const plugin = await import('../lib/index.js')
const registered = [], sections = []
const ctx = {
  tools: { register: t => registered.push(t) },
  systemPrompt: { section: s => sections.push(s), getSectionOrder: () => 42 },
}
await plugin.apply(ctx)
const save = registered.find(t => t.name === 'memory_save')
const exec = { signal: new AbortController().signal }
const idxPath = path.join(proj, '.dsh', 'memory', 'MEMORY.md')

test('v0.7.1 同前缀兄弟目录保存 → 根级（无垃圾 ../ 标签）', async () => {
  const r = await save.execute({ title: 'Sibling note', content: '从项目外同前缀目录保存' }, exec)
  assert.equal(r.saved, true)
  const idx = await fs.readFile(idxPath, 'utf8')
  const line = idx.split('\n').find(l => l.includes('Sibling note'))
  assert.ok(line, '索引行应存在')
  assert.ok(!/\) \[/.test(line), '不应有路径标签（兄弟目录在项目外，应为根级）')
  assert.ok(!line.includes('..'), '不应出现 ../ 相对垃圾标签')
})

test('v0.7.1 摘要含方括号 → 不误判为路径标签，根级照常注入', async () => {
  process.chdir(proj) // 回项目根，存根级（无 path）记忆
  await save.execute({ title: 'Bracket note', content: '[TODO] 修复登录流程的回调' }, exec)
  const idx = await fs.readFile(idxPath, 'utf8')
  const line = idx.split('\n').find(l => l.includes('Bracket note'))
  assert.ok(line, '索引行应存在')
  assert.ok(!/\(\d{4}-\d{2}-\d{2}\) \[/.test(line), '日期后不应有路径标签（本记忆是根级）')
  const text = sections[0].text({})
  assert.ok(text.includes('Bracket note'), '根级记忆应注入（修复前会被 [TODO] 误判隐藏）')
  assert.ok(text.includes('Sibling note'), '兄弟目录保存的根级记忆也应注入')
})

test('v0.7.1 索引上限按 UTF-8 字节计（中文不再 3 倍超限）', async () => {
  // 90 行中文索引 ≈ 28KB 字节但仅 ~12K 字符：修复前（按字符算）不截断，修复后截到 ≤25KB
  for (let i = 0; i < 90; i++) {
    await save.execute({ title: `压测${i}`, content: '张'.repeat(120) }, exec)
  }
  const buf = await fs.readFile(idxPath) // Buffer.length 即 UTF-8 字节数
  assert.ok(buf.length <= 25 * 1024 + 100, `索引字节 ${buf.length} 应 ≤ 25KB + header`)
})
