// 真实冒烟测试：加载编译产物 lib/index.js（对官方 cordis+dsh-tools 类型构建），
// 用桩宿主 ctx 调 apply()，端到端执行四个工具并验证存储与系统提示词注入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
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
  route.handler({}, res)
  await new Promise(resolve => setImmediate(resolve)) // GET handler resolves async
  const data = JSON.parse(body)
  assert.ok(data.scopes && typeof data.scopes.user === 'object', '应有 user 域')
  assert.ok(Array.isArray(data.scopes.projects), 'P2: projects 应为工作区数组')
  assert.ok(data.scopes.projects.length >= 1, '当前工作区应在列表中')
  const p = data.scopes.projects[0]
  assert.ok(p.serviceAnchor === true && Array.isArray(p.entries) && p.entries.length >= 1, '服务锚点工作区应有已存记忆')
  assert.ok(typeof p.stats.indexBytes === 'number' && p.stats.maxBytes === 25600, '护栏统计应含字节数')
  const entry = p.entries[0]
  assert.ok(entry.title && entry.date, '条目应解析出 title/date')
})

const postSave = async body => {
  const route = webRoutes.find(r => r.path === '/dsh-memory/api/v1/save' && r.method === 'POST')
  assert.ok(route, 'POST 路由应已注册')
  const req = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
  let status = 0, resBody = ''
  const res = { writeHead: s => { status = s }, end: s => { resBody = s } }
  await route.handler(req, res)
  for (let i = 0; i < 50 && resBody === ''; i++) await new Promise(r => setTimeout(r, 10))
  return { status, data: resBody === '' ? null : JSON.parse(resBody) }
}

test('P2 POST /save：user 域添加 → 落盘 + 索引 + ok 响应', async () => {
  const { status, data } = await postSave({ scope: 'user', title: 'Panel-added memory', content: 'Written from the settings panel.', tags: ['panel'] })
  assert.equal(status, 200)
  assert.ok(data.ok === true && data.saved === true, '应返回 ok+saved')
  assert.match(data.file, /panel-added-memory/, '文件名应含 slug')
  const index = await fs.readFile(path.join(tmp, 'MEMORY.md'), 'utf8')
  assert.match(index, /Panel-added memory/, '索引应含新条目')
})

test('P2 POST /save：拒绝未知 workspace（防任意路径写）', async () => {
  const { status, data } = await postSave({ scope: 'project', workspace: '/definitely/not/a/known/workspace', title: 'x', content: 'y' })
  assert.equal(status, 400)
  assert.match(data.error, /unknown workspace/)
})

test('P2 枚举：POST 写已知工作区 + 无记忆工作区被过滤', async () => {
  const fakeWs = path.join(tmp, 'fake-ws')
  const ledger = path.join(tmp, 'workspaces.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(ledger, JSON.stringify({ workspaces: [fakeWs, '/tmp/empty-ws-p2-test'] }), 'utf8')
  const saved = await postSave({ scope: 'project', workspace: fakeWs, title: 'Cross-ws memory', content: 'Saved into another workspace from the panel.' })
  assert.equal(saved.status, 200, '已知工作区应可写')
  const route = webRoutes.find(r => r.path === '/dsh-memory/api/v1/list')
  let body = ''
  const res = { writeHead: () => {}, end: s => { body = s } }
  route.handler({}, res)
  for (let i = 0; i < 50 && body === ''; i++) await new Promise(r => setTimeout(r, 10))
  const data = JSON.parse(body)
  const roots = data.scopes.projects.map(p => p.root)
  assert.ok(roots.includes(fakeWs), '已写入的假工作区应在列表')
  assert.ok(!roots.includes('/tmp/empty-ws-p2-test'), '无记忆工作区应被过滤')
})

test('P2.1 POST /delete：删除单条 → 文件消失 + 索引行移除', async () => {
  const saved = await postSave({ scope: 'user', title: 'Delete me', content: 'Temporary memory.' })
  assert.equal(saved.status, 200)
  const id = saved.data.id
  const route = webRoutes.find(r => r.path === '/dsh-memory/api/v1/delete' && r.method === 'POST')
  assert.ok(route, 'delete 路由应已注册')
  const req = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ scope: 'user', id })) } }
  let status = 0, resBody = ''
  const res = { writeHead: s => { status = s }, end: s => { resBody = s } }
  await route.handler(req, res)
  for (let i = 0; i < 50 && resBody === ''; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(status, 200)
  assert.equal(JSON.parse(resBody).deleted, id)
  const { access } = await import('node:fs/promises')
  await assert.rejects(access(saved.data.file), '文件应已删除')
  const index = await fs.readFile(path.join(tmp, 'MEMORY.md'), 'utf8')
  assert.ok(!index.includes(id), '索引行应已移除')
})

test('P2.1 POST /delete：恶意 id（路径穿越）被拒', async () => {
  const route = webRoutes.find(r => r.path === '/dsh-memory/api/v1/delete' && r.method === 'POST')
  const req = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ scope: 'user', id: '../../etc/passwd' })) } }
  let status = 0, resBody = ''
  const res = { writeHead: s => { status = s }, end: s => { resBody = s } }
  await route.handler(req, res)
  for (let i = 0; i < 50 && resBody === ''; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(status, 400)
  assert.match(JSON.parse(resBody).error, /invalid id/)
})

test('P2.2 修复回归：面板 id 带 .md 后缀也能删除（真实 bug 场景）', async () => {
  const saved = await postSave({ scope: 'user', title: 'Dot-md id test', content: 'Panel parses ids from index lines, which carry the .md suffix.' })
  assert.equal(saved.status, 200)
  const route = webRoutes.find(r => r.path === '/dsh-memory/api/v1/delete' && r.method === 'POST')
  const req = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ scope: 'user', id: `${saved.data.id}.md` })) } } // 带 .md！
  let status = 0, resBody = ''
  const res = { writeHead: s => { status = s }, end: s => { resBody = s } }
  await route.handler(req, res)
  for (let i = 0; i < 50 && resBody === ''; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(status, 200, `带 .md 的 id 应可删（面板真实场景），body=${resBody}`)
})

test('P2.2 read + update：编辑单条记忆端到端', async () => {
  const saved = await postSave({ scope: 'user', title: 'Edit me original', content: 'Original content.', tags: ['before'] })
  assert.equal(saved.status, 200)
  const id = saved.data.id
  const call = async (ep, body) => {
    const route = webRoutes.find(r => r.path === ep && r.method === 'POST')
    const req = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
    let status = 0, resBody = ''
    const res = { writeHead: s => { status = s }, end: s => { resBody = s } }
    await route.handler(req, res)
    for (let i = 0; i < 50 && resBody === ''; i++) await new Promise(r => setTimeout(r, 10))
    return { status, data: JSON.parse(resBody) }
  }
  const read = await call('/dsh-memory/api/v1/read', { scope: 'user', id })
  assert.equal(read.status, 200)
  assert.equal(read.data.content, 'Original content.')
  assert.deepEqual(read.data.tags, ['before'])
  const upd = await call('/dsh-memory/api/v1/update', { scope: 'user', id, title: 'Edit me revised', content: 'Revised content.', tags: ['after'] })
  assert.equal(upd.status, 200, `update 应成功: ${JSON.stringify(upd)}`)
  const reread = await call('/dsh-memory/api/v1/read', { scope: 'user', id })
  assert.equal(reread.data.title, 'Edit me revised')
  assert.equal(reread.data.content, 'Revised content.')
  assert.deepEqual(reread.data.tags, ['after'])
  const index = await fs.readFile(path.join(tmp, 'MEMORY.md'), 'utf8')
  assert.ok(index.includes('Edit me revised') && !index.includes('Edit me original'), '索引行应以新标题替换旧行')
})

test('P2.3 手动嵌套作用域：子文件夹里的 .dsh/memory 被发现并列出', async () => {
  const fakeWs = path.join(tmp, 'fake-ws-nest')
  const nested = path.join(fakeWs, 'sub', '.dsh', 'memory')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(path.join(nested, 'memories'), { recursive: true })
  writeFileSync(path.join(tmp, 'workspaces.json'), JSON.stringify({ workspaces: [fakeWs] }), 'utf8') // ledger 在 USER_DIR(tmp) 下
  // 直接在嵌套作用域落一条记忆（手写索引+文件，等价于用户从工程复制）
  const id = '20261009-150000-copied-memory'
  writeFileSync(path.join(nested, 'memories', `${id}.md`), '---\nid: ' + id + '\nscope: project\npath: \nsaved_at: 2026-10-09T15:00:00.000Z\ntags: \n---\n\n# Copied memory\n\nManually copied into a nested scope.\n')
  writeFileSync(path.join(nested, 'MEMORY.md'), `# Memory Index\n\n- [Copied memory](memories/${id}.md) — Manually copied into a nested scope. (2026-10-09)\n`)
  const route = webRoutes.find(r => r.path === '/dsh-memory/api/v1/list')
  let body = ''
  const res = { writeHead: () => {}, end: s => { body = s } }
  route.handler({}, res)
  for (let i = 0; i < 50 && body === ''; i++) await new Promise(r => setTimeout(r, 10))
  const data = JSON.parse(body)
  const nestedGroup = (data.scopes.projects ?? []).find(p => p.root === path.join(fakeWs, 'sub'))
  assert.ok(nestedGroup, `嵌套作用域应出现在列表: ${JSON.stringify((data.scopes.projects ?? []).map(p => p.root))}`)
  assert.equal(nestedGroup.name, 'sub', '嵌套组名应为相对路径名')
  assert.equal(nestedGroup.nested, true)
  assert.ok(nestedGroup.entries.length >= 1, '嵌套作用域的条目应可见')
})

test('v0.11 会话级注入：scope 携带会话 cwd → 注入该工作区的记忆', () => {
  const fakeWs = path.join(tmp, 'session-ws')
  const base = path.join(fakeWs, '.dsh', 'memory')
  mkdirSync(path.join(base, 'memories'), { recursive: true })
  writeFileSync(path.join(base, 'memories', '20261009-180000-session-only.md'), '---\nid: y\nscope: project\npath: \nsaved_at: 2026-10-09T18:00:00.000Z\ntags: \n---\n\n# Session workspace memory\n\nOnly visible to sessions in session-ws.\n')
  writeFileSync(path.join(base, 'MEMORY.md'), '# Memory Index\n\n- [Session workspace memory](memories/20261009-180000-session-only.md) — Only visible to sessions in session-ws. (2026-10-09)\n')
  const auto = sections.find(s => s.name === 'dsh-memory:auto')
  // 会话 scope 指向 fakeWs → 注入 fakeWs 的条目
  const wsText = auto.text({ scope: { cwd: fakeWs } })
  assert.ok(wsText.includes('## Persistent memory'), '应有注入头')
  assert.ok(wsText.includes('Session workspace memory'), '应注入会话工作区的记忆')
  // 无 scope（回退进程 cwd）→ 不含 fakeWs 条目
  const homeText = auto.text({})
  assert.ok(!homeText.includes('Session workspace memory'), '进程 cwd 会话不应看到 fakeWs 的记忆')
})

test('v0.11 会话级注入：path 标签按会话 cwd 过滤', () => {
  const fakeWs = path.join(tmp, 'session-ws2')
  const base = path.join(fakeWs, '.dsh', 'memory')
  mkdirSync(path.join(base, 'memories'), { recursive: true })
  writeFileSync(path.join(base, 'memories', '20261009-181000-root-mem.md'), 'x')
  writeFileSync(path.join(base, 'memories', '20261009-181001-api-mem.md'), 'y')
  writeFileSync(path.join(base, 'MEMORY.md'), '# Memory Index\n\n- [Root memory](memories/20261009-181000-root-mem.md) — root level. (2026-10-09)\n- [API memory](memories/20261009-181001-api-mem.md) — api only. (2026-10-09) [backend/api]\n')
  const auto = sections.find(s => s.name === 'dsh-memory:auto')
  // 会话 cwd 在 backend/api → root 级 + [backend/api] 标签的都注入
  const inApi = auto.text({ scope: { cwd: path.join(fakeWs, 'backend', 'api') } })
  assert.ok(inApi.includes('Root memory') && inApi.includes('API memory'), '会话在 backend/api：root + api 标签都应注入')
  // 会话 cwd 在别处 → api 标签被过滤且提示可搜
  const outside = auto.text({ scope: { cwd: path.join(fakeWs, 'frontend') } })
  assert.ok(outside.includes('Root memory'), 'root 级恒注入')
  assert.ok(!outside.includes('] — api only'), '他区标签记忆不应注入正文')
  assert.ok(outside.includes('memory_search surfaces them'), '应提示其他区域记忆可搜')
})

test('v0.11.1 写侧会话级：exec.agent 携带会话 → 默认存进该工作区 + path 标签按会话', async () => {
  const fakeWs = path.join(tmp, 'write-session-ws')
  mkdirSync(path.join(fakeWs, '.git'), { recursive: true }) // 真实工作区是 git 仓库：.git 锚定工作区根，避免远处 tmp 锚桶的 marker 劫持
  mkdirSync(path.join(fakeWs, 'backend', 'api'), { recursive: true })
  const execAgent = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: path.join(fakeWs, 'backend', 'api') } } }, // 官方形态：assembleContextFor 的 agent
  }
  const r = await tool('memory_save').execute({ title: 'Write side memory', content: 'Should land in the session workspace, not the process anchor.' }, execAgent)
  assert.ok(r.saved === true, `应保存成功: ${JSON.stringify(r)}`)
  assert.ok(r.file.startsWith(fakeWs), `应存进会话工作区: ${r.file}`)
  const index = await fs.readFile(path.join(fakeWs, '.dsh', 'memory', 'MEMORY.md'), 'utf8')
  assert.ok(index.includes('Write side memory'), '会话工作区索引应有该条目')
  assert.ok(index.includes('[backend/api]'), 'path 标签应按会话 cwd（backend/api）')
})

test('v0.11.1 读侧官方形态：context.agent.session.header.cwd → 注入该工作区', () => {
  const fakeWs = path.join(tmp, 'write-session-ws')
  const auto = sections.find(s => s.name === 'dsh-memory:auto')
  const text = auto.text({ agent: { session: { header: { cwd: path.join(fakeWs, 'backend', 'api') } } } }) // 与写侧同一会话 cwd（根目录会话按设计会懒过滤 [backend/api] 标签）
  assert.ok(text.includes('## Persistent memory'), '应有注入头')
  assert.ok(text.includes('Write side memory'), '应注入会话工作区的记忆（读写同桶）')
})

test('v0.11.1 读写对称：会话存的记忆同一会话能注入回来（跨进程验证修复）', async () => {
  const fakeWs2 = path.join(tmp, 'rw-symmetry-ws')
  mkdirSync(path.join(fakeWs2, '.git'), { recursive: true })
  // 写：exec.agent 指向 fakeWs2
  const w = await tool('memory_save').execute({ title: 'RW symmetry', content: 'Write then read the same bucket.' }, { signal: new AbortController().signal, agent: { session: { header: { cwd: fakeWs2 } } } })
  assert.ok(w.saved === true && w.file.startsWith(fakeWs2))
  // 读：同会话的 assembly 注入
  const auto = sections.find(s => s.name === 'dsh-memory:auto')
  const text = auto.text({ agent: { session: { header: { cwd: fakeWs2 } } } })
  assert.ok(text.includes('RW symmetry'), '该会话下一个 assembly 应注入刚存的记忆（对称性）')
})

test('v0.11.1 review 缺口①：会话保存 → 账本记录 → 面板可见（独立目录）', async () => {
  // review 场景复现：会话工作区不在服务锚内部、无 registry 记录
  const ws = path.join(tmp, 'review-ws')  // 独立目录（tmp 下但 self-contained）
  mkdirSync(path.join(ws, '.git'), { recursive: true })
  const r = await tool('memory_save').execute({ title: 'Review gap memory', content: 'Session saved into an independent workspace.' }, { signal: new AbortController().signal, agent: { session: { header: { cwd: ws } } } })
  assert.ok(r.saved === true && r.file.startsWith(ws), '会话保存应落进独立工作区')
  await new Promise(resolve => setTimeout(resolve, 100)) // 账本 fire-and-forget
  const ledger = JSON.parse(await fs.readFile(path.join(tmp, 'workspaces.json'), 'utf8'))
  assert.ok(ledger.workspaces.includes(ws), '账本应含会话工作区')
  const route = webRoutes.find(rr => rr.path === '/dsh-memory/api/v1/list')
  let body = ''
  route.handler({}, { writeHead: () => {}, end: s => { body = s } })
  for (let i = 0; i < 50 && body === ''; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const roots = JSON.parse(body).scopes.projects.map(p => p.root)
  assert.ok(roots.includes(ws), '面板应枚举出会话写入的工作区')
})

test('v0.11.1 review 缺口③：search 跨会话桶 + 锚桶（注入契约）', async () => {
  // 会话桶记忆可搜（注入说 memory_search surfaces them）
  const s1 = await tool('memory_search').execute({ query: 'Review gap' }, { signal: new AbortController().signal, agent: { session: { header: { cwd: path.join(tmp, 'review-ws') } } } })
  assert.ok(s1.matches.length >= 1, '会话桶记忆应可搜')
  // 锚桶旧记忆仍可搜（无 exec.agent 回退）
  const s2 = await tool('memory_search').execute({ query: 'Panel-added' }, { signal: new AbortController().signal })
  assert.ok(s2.matches.length >= 1, '锚桶旧记忆仍可搜（兜底）')
})

test('v0.11.1 review 缺口③：read 会话桶优先 + 锚桶兜底', async () => {
  const s1 = await tool('memory_search').execute({ query: 'Review gap' }, { signal: new AbortController().signal, agent: { session: { header: { cwd: path.join(tmp, 'review-ws') } } } })
  const id = s1.matches[0].id
  const r1 = await tool('memory_read').execute({ id }, { signal: new AbortController().signal, agent: { session: { header: { cwd: path.join(tmp, 'review-ws') } } } })
  assert.ok(r1.content?.includes('independent workspace'), '会话桶读取')
  const s2 = await tool('memory_search').execute({ query: 'Panel-added' }, { signal: new AbortController().signal })
  const r2 = await tool('memory_read').execute({ id: s2.matches[0].id }, { signal: new AbortController().signal })
  assert.ok(r2.content !== undefined, '锚桶兜底读取')
})

test('v0.11.1 review 缺口③：list 合并两桶', async () => {
  const out = await tool('memory_list').execute({}, { signal: new AbortController().signal, agent: { session: { header: { cwd: path.join(tmp, 'review-ws') } } } })
  assert.ok(out.project.entries.some(l => l.includes('Review gap')), '会话桶在列表')
  assert.ok(out.project.entries.some(l => l.includes('Prefer Pnpm')), '锚桶 project 记忆也在列表（合并）')
})

test('v0.11.2 空态显示：目录存在但无记忆的工作区也列出（引导添加第一条）', async () => {
  const emptyWs = path.join(tmp, 'empty-but-real-ws')
  mkdirSync(emptyWs, { recursive: true }) // 目录存在、无 .dsh/memory
  const { writeFileSync: wf } = await import('node:fs')
  wf(path.join(tmp, 'workspaces.json'), JSON.stringify({ workspaces: [emptyWs] }), 'utf8')
  const route = webRoutes.find(rr => rr.path === '/dsh-memory/api/v1/list')
  let body = ''
  route.handler({}, { writeHead: () => {}, end: s => { body = s } })
  for (let i = 0; i < 50 && body === ''; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const group = JSON.parse(body).scopes.projects.find(p => p.root === emptyWs)
  assert.ok(group, '空工作区应显示（空态）')
  assert.equal(group.entries.length, 0, '条目为空')
  assert.equal(group.stats.entries, 0, 'stats 全 0')
})
