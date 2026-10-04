// v0.4 检测链测试：env > 标记 > VCS(.git/.svn/.hg) > cwd兜底 + 巨型目录护栏
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveProjectScope } from '../lib/index.js'

const mk = async () => fs.mkdtemp(path.join(os.tmpdir(), 'dsh-det-'))
const fh = t => path.join(t, 'fake-home') // 注入的假 home，不碰真实系统

test('SVN 项目：从子目录向上爬到 .svn 根', async () => {
  const t = await mk()
  await fs.mkdir(path.join(t, 'proj', 'src'), { recursive: true })
  await fs.mkdir(path.join(t, 'proj', '.svn'))
  const r = resolveProjectScope(path.join(t, 'proj', 'src'), { homeDir: fh(t) })
  assert.equal(r.dir, path.join(t, 'proj', '.dsh', 'memory'))
  assert.equal(r.source, 'walk')
})

test('Mercurial 同理（.hg）', async () => {
  const t = await mk()
  await fs.mkdir(path.join(t, 'proj', '.hg'), { recursive: true })
  const r = resolveProjectScope(path.join(t, 'proj'), { homeDir: fh(t) })
  assert.equal(r.dir, path.join(t, 'proj', '.dsh', 'memory'))
})

test('无 VCS 纯本地目录：cwd 兜底（不再混进用户级）', async () => {
  const t = await mk()
  const r = resolveProjectScope(t, { homeDir: fh(t) })
  assert.equal(r.dir, path.join(t, '.dsh', 'memory'))
  assert.equal(r.source, 'cwd')
})

test('子目录爬回已存在的标记（自标识锚点）', async () => {
  const t = await mk()
  await fs.mkdir(path.join(t, 'proj', '.dsh', 'memory'), { recursive: true })
  await fs.mkdir(path.join(t, 'proj', 'a', 'b'), { recursive: true })
  const r = resolveProjectScope(path.join(t, 'proj', 'a', 'b'), { homeDir: fh(t) })
  assert.equal(r.dir, path.join(t, 'proj', '.dsh', 'memory'))
  assert.equal(r.source, 'walk')
})

test('嵌套标记胜过外层 VCS 根（子项目作用域）', async () => {
  const t = await mk()
  await fs.mkdir(path.join(t, 'repo', '.git'), { recursive: true })
  await fs.mkdir(path.join(t, 'repo', 'sub', '.dsh', 'memory'), { recursive: true })
  const r = resolveProjectScope(path.join(t, 'repo', 'sub', 'deep'), { homeDir: fh(t) })
  assert.equal(r.dir, path.join(t, 'repo', 'sub', '.dsh', 'memory'))
})

test('环境变量覆盖最高优先', async () => {
  const t = await mk()
  const elsewhere = path.join(t, 'elsewhere')
  process.env.DSH_MEMORY_PROJECT_DIR = elsewhere
  try {
    const r = resolveProjectScope(path.join(t, 'other'), { homeDir: fh(t) })
    assert.equal(r.dir, path.join(elsewhere, '.dsh', 'memory'))
    assert.equal(r.source, 'env')
  } finally {
    delete process.env.DSH_MEMORY_PROJECT_DIR
  }
})

test('$HOME 护栏：dotfiles 场景免疫（~/.git 不会污染 home 桶）', async () => {
  const t = await mk()
  const home = path.join(t, 'home')
  await fs.mkdir(path.join(home, '.git'), { recursive: true })
  await fs.mkdir(path.join(home, 'work', 'projX'), { recursive: true })
  const r = resolveProjectScope(path.join(home, 'work', 'projX'), { homeDir: home })
  assert.equal(r.dir, path.join(home, 'work', 'projX', '.dsh', 'memory'))
  assert.notEqual(r.dir, path.join(home, '.dsh', 'memory'))
  assert.equal(r.source, 'cwd')
})

test('护栏目录本身（home 与 /tmp）→ 无项目作用域', async () => {
  const t = await mk()
  const home = path.join(t, 'home')
  await fs.mkdir(home, { recursive: true })
  assert.equal(resolveProjectScope(home, { homeDir: home }).dir, undefined)
  assert.equal(resolveProjectScope('/tmp', { homeDir: '/nonexistent' }).source, 'none')
})
