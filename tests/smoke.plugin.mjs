// 真实冒烟测试：加载编译产物 lib/index.js（对官方 cordis+dsh-tools 类型构建），
// 用桩宿主 ctx 调 apply()，端到端执行四个工具并验证存储与系统提示词注入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-smoke-'))
process.env.DSH_MEMORY_USER_DIR = tmp
process.chdir(tmp) // 无 .git 祖先 → 项目作用域缺失 → 默认存用户级（同时验证优雅降级路径）

const plugin = await import('../lib/index.js')

const registered = []
const sections = []
const webRoutes = []
const ctx = {
  tools: { register: t => registered.push(t) },
  systemPrompt: {
    section: s => sections.push(s),
    getSectionOrder: k => 42,
  },
  inject: (names, cb) => {
    if (names.includes('webServer')) cb({ webServer: { register: r => { webRoutes.push(r); return () => {} } } })
  },
}
plugin.apply(ctx)
const tool = n => registered.find(t => t.name === n)
const exec = { signal: new AbortController().signal }
let savedId = ''

test('插件注册 4 工具 + 1 系统提示词段', () => {
  assert.deepEqual([...plugin.inject].sort(), ['systemPrompt', 'tools'], 'inject 必须声明所有被访问的服务（真实宿主缺声明直接拒绝激活）')
  assert.equal(registered.length, 4)
  assert.deepEqual(registered.map(t => t.name).sort(),
    ['memory_list', 'memory_read', 'memory_save', 'memory_search'])
  assert.equal(sections.length, 1)
})

test('presentCall 返回合法 ToolCallView（card 标签）', () => {
  const views = [
    tool('memory_save').presentCall({ title: 'x', content: 'y' }),
    tool('memory_search').presentCall({ query: 'q' }),
    tool('memory_read').presentCall({ id: 'i' }),
    tool('memory_list').presentCall({}),
  ]
  for (const v of views) {
    assert.equal(v?.card, 'generic', `card 标签缺失: ${JSON.stringify(v)}`)
    assert.ok(typeof v.title === 'string' && v.title.length > 0)
  }
})

test('memory_save 端到端：写文件 + 护栏索引', async () => {
  const saved = await tool('memory_save').execute(
    { title: 'Prefer pnpm', content: '用户偏好：本项目一律用 pnpm，不用 npm。', tags: ['pref'] }, exec)
  assert.equal(saved.saved, true)
  assert.equal(saved.scope, 'project') // v0.4: 沙箱无 VCS → cwd 兜底 → 默认项目作用域
  savedId = saved.id
  const idx = await fs.readFile(path.join(tmp, '.dsh', 'memory', 'MEMORY.md'), 'utf8') // v0.4: 项目作用域路径
  assert.ok(idx.includes('Prefer pnpm'), '索引应含新记忆')
})

test('memory_search 大小写不敏感跨域检索', async () => {
  // 文件名命中路径：excerpt 为 '(id match)'，断言 id
  const byId = await tool('memory_search').execute({ query: 'PNPM' }, exec)
  assert.equal(byId.total, 1)
  assert.equal(byId.matches[0].scope, 'project')
  assert.ok(byId.matches[0].id.includes('prefer-pnpm'), `id 应含 slug: ${byId.matches[0].id}`)
  // 正文命中路径：中文查询只可能在正文，excerpt 应含上下文
  const byContent = await tool('memory_search').execute({ query: '用户偏好' }, exec)
  assert.equal(byContent.total, 1)
  assert.ok(byContent.matches[0].excerpt.includes('pnpm'), `excerpt 应含正文: ${byContent.matches[0].excerpt}`)
})

test('memory_read 返回 Claude 契约字段', async () => {
  const r = await tool('memory_read').execute({ id: savedId }, exec)
  assert.ok(r.content.includes('pnpm'))
  assert.equal(r.truncated, false)
  assert.ok(typeof r.size_bytes === 'number')
  assert.ok(typeof r.updated_at === 'string')
})

test('memory_list 双域分组', async () => {
  const r = await tool('memory_list').execute({}, exec)
  assert.ok(r.project.entries.length >= 1)
  assert.equal(r.user.truncated, false)
})

test('系统提示词注入段含已存记忆（醒来带记忆）', () => {
  const text = sections[0].text({})
  assert.ok(text.includes('## Persistent memory'))
  assert.ok(text.includes('Prefer pnpm'))
})

test('v0.5 去重更新：同主题再存 → 原地更新而非追加', async () => {
  const again = await tool('memory_save').execute(
    { title: 'Prefer Pnpm', content: '更新后的偏好：pnpm + pnpm-workspace，绝不用 npm。' }, exec)
  assert.equal(again.updated, true, '应标记为更新')
  assert.equal(again.id, savedId, '应复用同一文件 id')
  const files = await fs.readdir(path.join(tmp, '.dsh', 'memory', 'memories'))
  assert.equal(files.filter(f => f.includes('prefer-pnpm')).length, 1, '磁盘上仍只有一个文件')
  const r2 = await tool('memory_list').execute({}, exec)
  const lines = r2.project.entries.filter(l => l.includes('prefer-pnpm') || l.includes('Prefer Pnpm'))
  assert.equal(lines.length, 1, '索引仍只有一行')
})

test('v0.5 索引行带日期（新鲜度可推理）', async () => {
  const idx = await fs.readFile(path.join(tmp, '.dsh', 'memory', 'MEMORY.md'), 'utf8')
  assert.ok(/\(\d{4}-\d{2}-\d{2}\)/.test(idx), '索引行应含 YYYY-MM-DD 日期')
})

test('v0.7 两段式提示：其他区域记忆不注入但明示可搜', async () => {
  // cwd = tmp = 项目根，不属于 backend/ → 该记忆被惰性过滤，但注入段应明示其存在
  await tool('memory_save').execute(
    { title: 'API gateway port', content: 'backend 网关固定用 8080 端口，勿改。', path: 'backend' }, exec)
  const text = sections[0].text({})
  assert.ok(!text.includes('API gateway port'), '其他区域的记忆不应注入')
  assert.ok(text.includes('+1 more tagged to other areas'), '应提示还有其他区域记忆可搜')
})

test('v0.7 工作目录进入子目录后该区域记忆注入', async () => {
  await fs.mkdir(path.join(tmp, 'backend'), { recursive: true })
  process.chdir(path.join(tmp, 'backend'))
  try {
    const text = sections[0].text({})
    assert.ok(text.includes('API gateway port'), '区域内的记忆应注入')
    assert.ok(!text.includes('+1 more tagged'), '进入区域后不再有过滤提示（root 级恒注入）')
  } finally {
    process.chdir(tmp)
  }
})

test('P1 数据桥：GET /dsh-memory/api/v1/list 返回双域 JSON', async () => {
  const route = webRoutes.find(r => r.path === '/dsh-memory/api/v1/list')
  assert.ok(route, '路由应已注册')
  assert.equal(route.method, 'GET')
  let body = ''
  const res = { writeHead: () => {}, end: s => { body = s } }
  await route.handler({}, res)
  const data = JSON.parse(body)
  assert.ok(data.scopes && typeof data.scopes.user === 'object', '应有 user 域')
  assert.ok(data.scopes.project, '应有 project 域')
  const p = data.scopes.project
  assert.ok(p.available === true && Array.isArray(p.entries) && p.entries.length >= 1, 'project 域应有已存记忆')
  assert.ok(typeof p.stats.indexBytes === 'number' && p.stats.maxBytes === 25600, '护栏统计应含字节数')
  const entry = p.entries[0]
  assert.ok(entry.title && entry.date, '条目应解析出 title/date')
})
