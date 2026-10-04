# dsh-memory

![npm](https://img.shields.io/npm/v/@fooxe/dsh-memory) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22.19-green)

**English** | [**中文版**](#中文版) 　*(npm renders this file only — both languages are included below / npm 只渲染本文件，中英文都在下面)*

**Hierarchical Claude Code-style persistent memory for DeepSeek Harness — session-start auto-injection, user + project scopes, zero runtime dependencies.**

---

## English

DSH ships memory as opt-in third-party MCP servers: off by default, provisioning on you, no size guards, and the model often forgets to call the tools. `dsh-memory` takes the opposite trade — memory as a first-class plugin, following the design Claude Code proved at scale:

| | dsh-memory | Official MCP route | Claude Code native |
|---|---|---|---|
| Default state | on once installed | off, manual config | on |
| External server | **none** (pure files) | required | none |
| Index guard | 200 lines / 25 KB hard caps | none | 200 lines / 25 KB |
| Store cap | 500 memories / scope, auto-pruned | none | — |
| Session-start injection | ✅ via `ctx.systemPrompt` | ❌ model-initiated | ✅ |
| Scopes | user (personal) + project (git-shared) | server-dependent | project docs |
| Openness | MIT, fully inspectable | varies | closed source |

## Tools

| Tool | Purpose |
|---|---|
| `memory_save` | Save a durable memory; scope defaults to project inside a git repo, user elsewhere |
| `memory_search` | Case-insensitive keyword search across both scopes (ids, titles, tags, content) |
| `memory_read` | Read one full memory; field contract mirrors Claude Code's shipped `project_memory_read` (`content?`, `local_file?`, `size_bytes`, `updated_at`, `truncated`) |
| `memory_list` | Recent memories per scope, newest first |

Tool descriptions carry proactive-save guidance, so the model saves user preferences, project decisions and key facts without being asked — and never saves secrets.

## Quick start

```sh
npm install -g @fooxe/dsh-memory
# or
pnpm add -g @fooxe/dsh-memory
dsh web --patch ./overlay/dsh-memory.cordis.yml
```

Verify in 3 steps (any chat):
1. "Remember that I prefer pnpm over npm." → the model calls `memory_save`; check `~/.dsh/memory/MEMORY.md` gains an entry.
2. Start a **new** session: "Which package manager do I prefer?" → the injected index lets it answer without re-asking.
3. "Save the decision: we use A instead of B, because C." (inside a git repo) → lands in `<git-root>/.dsh/memory/`, ready to commit for the whole team.

## How it works

Four principles, ported from Claude Code's public behavior:

1. **MEMORY.md index** — compact, newest-first, always readable.
2. **Hard guards** — index truncates at 200 lines / 25 KB so memory can never silently eat the context window; 500 memories per scope with oldest-first pruning.
3. **Behavioral auto-memory** — proactive-save guidance embedded in tool descriptions.
4. **Files as truth** — no server, no embedding, no account.

```
~/.dsh/memory/                      ← user scope (personal, cross-project)
├── MEMORY.md                       ← guarded index
└── memories/20261004-181500-prefer-pnpm.md
<git-root>/.dsh/memory/             ← project scope (team-shared, committed)
├── MEMORY.md
└── memories/*.md
```

At session start both scope indexes are injected into the system prompt via `ctx.systemPrompt` (gracefully skipped on hosts without that service — tools keep working).

## Verification

Three levels, all runnable from the repo:

```sh
npm install          # devDependencies pin the full rc peer set
npm run build        # tsc against official @deepseek-ai types
npm test             # 12 tests: storage guards, review guards, runtime smoke
```

- **Unit** — index truncation, save/search round-trip, review guards (no `require()` in ESM; plugin name matches package name).
- **Type compile** — builds against the shipped `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` type definitions.
- **Runtime smoke** — loads the compiled plugin with the real `dsh-tools` `defineTool`, registers all four tools plus the system-prompt section on a stub host, and executes save → search → read → list end-to-end, including the injected-memory check.

## Development notes

- External plugins don't need dsh host packages at runtime (the host provides them); the `devDependencies` set exists for standalone build/test, because the current `0.0.1-rc.1` dsh packages ship an incomplete standalone dependency graph.
- `systemPrompt` access uses a narrow structural type with graceful degradation — see `src/index.ts`.

## License

MIT. Not affiliated with DeepSeek or Anthropic; "Claude Code-style" describes the memory design, not the vendor.

---

# 中文版

**给 DeepSeek Harness 装上 Claude Code 同款记忆——会话启动自动注入、用户级+项目级分层存储、纯文件零依赖。**

DSH 官方的记忆方案是"外挂"：默认关闭、要自配 MCP 服务、无护栏、模型经常忘记调用。本插件反其道而行——把 Claude Code 验证过的记忆架构做成一等公民：

| | dsh-memory | 官方 MCP 方案 | Claude Code 原生 |
|---|---|---|---|
| 默认状态 | 装上即用 | 关，手动配置 | 开 |
| 外部服务 | **无**（纯文件） | 需要 | 无 |
| 索引护栏 | 200 行 / 25 KB 硬上限 | 无 | 200 行 / 25 KB |
| 存储上限 | 每作用域 500 条自动修剪 | 无 | — |
| 启动注入 | ✅ ctx.systemPrompt | ❌ 靠模型自觉 | ✅ |
| 作用域 | 用户级（个人）+ 项目级（git 共享） | 视服务而定 | 项目文档 |
| 开放性 | MIT 完全可查 | 各异 | 闭源 |

## 四个工具

| 工具 | 作用 |
|---|---|
| `memory_save` | 保存持久记忆；git 仓库内默认存项目级，否则存用户级 |
| `memory_search` | 大小写不敏感关键词检索（id/标题/标签/正文，跨双域） |
| `memory_read` | 读完整记忆；字段契约对齐 Claude Code 官方 `project_memory_read`（content?/local_file?/size_bytes/updated_at/truncated） |
| `memory_list` | 双域最近记忆列表（新→旧） |

工具描述内置主动保存指引：偏好、决策、关键数字主动存；密钥和临时信息不存。

## 快速开始

```sh
npm install -g @fooxe/dsh-memory
# or
pnpm add -g @fooxe/dsh-memory
dsh web --patch ./overlay/dsh-memory.cordis.yml
```

**三步验证**（任意会话里聊）：
1. "记住我喜欢 pnpm 不用 npm" → 模型调 memory_save；`~/.dsh/memory/MEMORY.md` 出现新条目
2. **新开会话**问"我喜欢什么包管理器？" → 注入的索引让它直接答出，不用重复问
3. 在 git 仓库里说"记住决策：我们用 A 不用 B，因为 C" → 落到 `<git根>/.dsh/memory/`，提交 git 全组共享

## 工作原理（Claude Code 四原则）

1. **MEMORY.md 索引**——紧凑、最新在前、随时可读
2. **硬护栏**——索引 200 行/25 KB 截断 + 每域 500 条封顶，记忆永远吃不掉上下文窗口
3. **行为化自动记忆**——工具描述内置"何时该存"指引
4. **文件即真相**——无服务、无 embedding、无账号

```
~/.dsh/memory/                      ← 用户级（个人、跨项目）
├── MEMORY.md                       ← 护栏索引
└── memories/20261004-181500-prefer-pnpm.md
<git根>/.dsh/memory/                ← 项目级（团队共享、随 git）
├── MEMORY.md
└── memories/*.md
```

会话启动时双域索引经 `ctx.systemPrompt` 注入系统提示词（宿主无该服务时优雅跳过，工具照常工作）。

## 验证体系（三层，仓库内可复现）

```sh
npm install          # devDependencies 钉死 rc 依赖闭包
npm run build        # 对官方 @deepseek-ai 类型 tsc 编译
npm test             # 12 项测试：存储护栏 + review 守卫 + 运行时冒烟
```

- **单元层**——索引截断、存取回环、review 守卫（ESM 禁 require、插件名=包名）
- **类型层**——对着官方 cordis + dsh-tools 类型定义真实编译
- **运行时层**——用真 defineTool 加载编译产物，桩宿主上注册四工具+注入段，端到端执行 save→search→read→list，含"醒来带记忆"验证

## 开发说明

- 外部插件运行时不需要 dsh 宿主包（宿主提供）；devDependencies 仅为独立构建/测试而设——当前 0.0.1-rc.1 的 dsh 包独立依赖图不完整
- systemPrompt 访问采用窄结构类型 + 优雅降级，详见 src/index.ts

## 协议

MIT。与 DeepSeek / Anthropic 无关联；"Claude Code 式"仅描述记忆设计思想。
