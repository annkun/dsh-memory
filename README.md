# dsh-memory

![npm](https://img.shields.io/npm/v/@fooxe/dsh-memory) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22.19-green)

**English** | [**中文版**](#中文版)

**Hierarchical persistent memory for DeepSeek Harness — inspired by the memory design Claude Code popularized. Your agents remember across sessions, wake up with context, and never mix projects.**

---

## English

## What it does

DSH agents start every session from zero — preferences, decisions, and hard-won context evaporate between conversations. `dsh-memory` fixes that: the agent **saves what matters as it appears** (your preferences, project decisions, key numbers, lessons) and **wakes up with those memories already in context** in every future session.

## Innovations

**1. Two-level scopes — cross-project, zero confusion**

- **User scope** (`~/.dsh/memory`): personal preferences and habits, stored once, available in *every* project. Stop re-explaining "I prefer pnpm" in each repo.
- **Project scope** (`<git-root>/.dsh/memory`): decisions and conventions stored *inside* their own project, committed to git, shared with the whole team automatically.
- The two never mix: project A's architectural decisions stay out of project B, while your personal style follows you everywhere.
- Scope auto-detection (v0.4): `DSH_MEMORY_PROJECT_DIR` env override > an existing `.dsh/memory` marker above (supports nested sub-project scopes) > any VCS root — `.git`, `.svn` or `.hg` (SVN/Mercurial projects anchor correctly on first use) > the current directory itself (VCS-less projects get their own scope instead of flooding the user bucket). `$HOME`, `/` and `/tmp` never become a scope: a dotfiles `~/.git` cannot turn home into one giant shared bucket.

**2. Session-start auto-injection**

Both scope indexes are seeded into the system prompt when a session starts (`ctx.systemPrompt`). The agent doesn't need to remember to look things up — it begins every conversation already knowing your context.

**3. Context-window guards**

Memory should grow in value, not in token cost: the `MEMORY.md` index is hard-capped at 200 lines / 25 KB, each scope holds at most 500 memories with oldest-first pruning, and oversized memories return a truncated preview plus an on-disk path (`local_file`) instead of flooding the window.

**4. Claude Code-compatible read contract**

`memory_read` returns the same field contract as Claude Code's shipped `project_memory_read` — `content?`, `local_file?`, `size_bytes`, `updated_at`, `truncated` — so tooling and habits transfer.

**5. Zero footprint**

Pure files. No server process, no embedding provider, no account, no database. Delete a scope's directory and that scope forgets everything.

## Tools

| Tool | Purpose |
|---|---|
| `memory_save` | Save a durable memory; scope defaults to project inside a git repo, user elsewhere |
| `memory_search` | Case-insensitive keyword search across both scopes (ids, titles, tags, content) |
| `memory_read` | Read one full memory (Claude Code contract fields) |
| `memory_list` | Recent memories per scope, newest first |

Tool descriptions embed proactive-save guidance — preferences, decisions and key facts get saved without being asked; secrets never do.

## Quick start

```sh
npm install -g @fooxe/dsh-memory
# or
pnpm add -g @fooxe/dsh-memory

dsh web --patch ./overlay/dsh-memory.cordis.yml
```

Verify in 3 steps (any chat):
1. "Remember that I prefer pnpm over npm." → `memory_save` fires; `~/.dsh/memory/MEMORY.md` gains an entry.
2. Start a **new** session: "Which package manager do I prefer?" → answered from the injected index, no re-asking.
3. Inside a git repo: "Save the decision: we use A instead of B, because C." → lands in `<git-root>/.dsh/memory/`, commit it and the whole team shares it.

## Storage layout

```
~/.dsh/memory/                      <- user scope (personal, cross-project)
|-- MEMORY.md                      <- guarded index, newest first
|-- memories/20261004-181500-prefer-pnpm.md
<git-root>/.dsh/memory/             <- project scope (team-shared, committed)
```

Hosts without the `systemPrompt` service simply skip auto-injection — all four tools keep working.

## Verification

Three levels, all runnable from the repo:

```sh
npm install && npm run build && npm test   # 12 tests, zero type errors
```

- **Unit** — index truncation, save/search round-trip, review guards (no `require()` in ESM; plugin name matches package name)
- **Type compile** — builds against the shipped `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` types
- **Runtime smoke** — loads the compiled plugin with the real `defineTool`, registers all tools plus the prompt section on a stub host, executes save -> search -> read -> list end-to-end

dsh-memory happily coexists with DSH's official MCP memory options — pick whichever fits your workflow, or use both.

## License

MIT. Not affiliated with DeepSeek or Anthropic.

---

# 中文版

**给 DeepSeek Harness 装上跨会话持久记忆——灵感来自 Claude Code 的记忆设计。你的 agent 记得住、醒得来、项目之间不串味。**

## 这个插件做什么

DSH 的 agent 每次会话都从零开始——偏好、决策、来之不易的上下文，聊完就蒸发。`dsh-memory` 解决这个问题：agent **在信息出现时自动存下重要的东西**（你的偏好、项目决策、关键数字、经验教训），并在**之后每次会话开场就带着这些记忆**。

## 创新点

**1. 分层作用域——跨项目、零混乱**

- **用户级**（`~/.dsh/memory`）：个人偏好和习惯，存一次，*所有项目*通用。不用每个仓库重新解释"我用 pnpm"
- **项目级**（`<git根>/.dsh/memory`）：决策和约定存在*它所属的项目里*，随 git 提交，自动共享给全组
- **两级永不混淆**：A 项目的架构决策不会漏进 B 项目，你的个人风格却处处跟随。作用域自动检测——git 仓库内默认存项目级，仓库外存用户级

**2. 会话启动自动注入**

会话开始时（`ctx.systemPrompt`）双域索引直接进入系统提示词。agent 不需要"记得去查"——每场对话开场就已经了解你的上下文。

**3. 上下文窗口护栏**

记忆应该增值，不该吃 token：`MEMORY.md` 索引硬上限 200 行 / 25 KB，每域最多 500 条自动修剪，超长记忆返回截断预览 + 磁盘路径（`local_file`），绝不淹没上下文。

**4. Claude Code 兼容读取契约**

`memory_read` 返回与 Claude Code 官方 `project_memory_read` 相同的字段契约——`content?`、`local_file?`、`size_bytes`、`updated_at`、`truncated`，工具链和习惯无缝迁移。

**5. 零负担**

纯文件。无服务进程、无 embedding、无账号、无数据库。删掉哪个作用域的目录，哪个作用域就彻底遗忘。

## 四个工具

| 工具 | 作用 |
|---|---|
| `memory_save` | 保存持久记忆；git 仓库内默认存项目级，否则存用户级 |
| `memory_search` | 大小写不敏感关键词检索（id/标题/标签/正文，跨双域） |
| `memory_read` | 读完整记忆（Claude Code 契约字段） |
| `memory_list` | 双域最近记忆列表（新→旧） |

工具描述内置主动保存指引——偏好、决策、关键数字不用吩咐就存，密钥永不存。

## 快速开始

```sh
npm install -g @fooxe/dsh-memory
# 或
pnpm add -g @fooxe/dsh-memory

dsh web --patch ./overlay/dsh-memory.cordis.yml
```

**三步验证**：① 说"记住我喜欢 pnpm"→ 看 `~/.dsh/memory/MEMORY.md` 多了条目 ② **新开会话**问"我喜欢什么包管理器"→ 直接答出 ③ git 仓库里说"记住决策：用 A 不用 B，因为 C" → 落进项目记忆，提交 git 全组共享

## 验证体系

```sh
npm install && npm run build && npm test   # 12 项测试，0 类型错误
```

dsh-memory 与 DSH 官方的 MCP 记忆方案完全共存——按工作流任选，或两者同用。

## 协议

MIT。与 DeepSeek、Anthropic 无关联。
