// P0 写侧加固回归（v0.8.0 分支 feat/p0-atomic-write）：
// 1) 并发 save：MEMORY.md 永不半截（原子写保完整；丢更新属 P2 乐观锁范畴，不在断言内）
// 2) 残留 tmp：上次中断写留下的 .tmp 在下次写入前被清掉
// 3) 孤儿行自愈：指向已删记忆文件的索引行从读取路径（list/注入）消失，磁盘索引读时不动
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-atomic-'))
process.env.DSH_MEMORY_USER_DIR = path.join(tmp, 'user')
process.env.DSH_MEMORY_PROJECT_DIR = tmp // 项目根 = 沙箱（env 优先级最高）
process.chdir(tmp)

const plugin = await import('../lib/index.js')
const registered = []
const ctx = {
  tools: { register: t => registered.push(t) },
  systemPrompt: { section: () => {}, getSectionOrder: () => 42 },
}
await plugin.apply(ctx)
const save = registered.find(t => t.name === 'memory_save')
const list = registered.find(t => t.name === 'memory_list')
const exec = { signal: new AbortController().signal }
const idxPath = path.join(tmp, '.dsh', 'memory', 'MEMORY.md')
const memDir = path.join(tmp, '.dsh', 'memory', 'memories')

test('P0 并发 save：索引文件永不损坏', async () => {
  const results = await Promise.all([
    save.execute({ title: 'Concurrent One', content: 'first concurrent memory' }, exec),
    save.execute({ title: 'Concurrent Two', content: 'second concurrent memory' }, exec),
  ])
  for (const r of results) assert.equal(r.saved, true, '两个 save 都应成功')
  const idx = await fs.readFile(idxPath, 'utf8')
  assert.ok(idx.startsWith('# Memory Index'), '文件头完整（非半截文件）')
  assert.ok(idx.endsWith('\n'), '文件尾完整')
  const lines = idx.split('\n').filter(l => l.startsWith('- '))
  assert.ok(lines.length >= 1 && lines.length <= 2,
    `行数 ${lines.length} 应 ∈ [1,2]（原子写保完整；并发丢更新留给 P2 乐观锁）`)
})

test('P0 孤儿 tmp：不影响写入、自身 tmp 被 rename 消费', async () => {
  const stale = `${idxPath}.crashed-old.tmp`
  await fs.writeFile(stale, 'stale garbage from a crashed write', 'utf8')
  await save.execute({ title: 'Tmp Cleaner', content: 'after stale tmp' }, exec)
  const idx = await fs.readFile(idxPath, 'utf8')
  assert.ok(idx.includes('Tmp Cleaner'), '孤儿 tmp 不影响正常写入')
  // save 自身的 tmp 已被 rename 消费：目录里的 .tmp 只有手动放的 stale 那个，无新增残留
  const tmps = (await fs.readdir(path.dirname(idxPath))).filter(f => f.endsWith('.tmp'))
  assert.deepEqual(tmps, [path.basename(stale)], `不应新增 tmp 残留，实际: ${tmps}`)
  await fs.rm(stale)
})

test('P0 孤儿行自愈：指向已删记忆文件的索引行从读取路径消失', async () => {
  const before = await list.execute({}, exec)
  const count = before.project.entries.length
  assert.ok(count >= 2, `前置：至少 2 条记忆，实际 ${count}`)
  // 删掉最新一条（索引第一行）指向的记忆文件，模拟 prune/手动删后留下的孤儿行
  const m = /\(memories\/([^)]+)\)/.exec(before.project.entries[0])
  assert.ok(m, '索引行应含 memories/ 链接')
  await fs.rm(path.join(memDir, m[1]))
  const after = await list.execute({}, exec)
  assert.equal(after.project.entries.length, count - 1, '孤儿行应被过滤')
  const idxOnDisk = await fs.readFile(idxPath, 'utf8')
  assert.ok(idxOnDisk.includes(m[1]), '磁盘索引读时未动（下次 save 才重写自愈）')
  // 再 save 一条 → 索引重写后孤儿行彻底消失（自愈落盘）
  await save.execute({ title: 'Heal Writer', content: 'triggers index rewrite' }, exec)
  const healed = await fs.readFile(idxPath, 'utf8')
  assert.ok(!healed.includes(m[1]), 'save 后孤儿行从磁盘索引消失')
})
