# dsh-memory

![npm](https://img.shields.io/npm/v/@fooxe/dsh-memory) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22.19-green)

**English** | [**中文版**](#中文版)

**Hierarchical persistent memory for DeepSeek Harness — inspired by the memory design Claude Code popularized. Your agents remember across sessions, wake up with context, and never mix projects.**

---

## English

## What it does

> Your DSH agent meets you for the "first time" — **every single session**.
> With dsh-memory, it remembers.

Tired of re-explaining *"I prefer pnpm"* in every project? Re-describing last week's architecture decision? `dsh-memory` gives your agent a durable memory: it **saves what matters as it appears** (preferences, project decisions, key numbers, lessons) and **every future session starts with those memories already in context**.

Here's what it looks like 30 seconds after install:

```text
Session 1   You: "Remember — this project uses pnpm, not npm."
            Agent: saved via memory_save

Session 2   You: "Which package manager do we use?"
            Agent: "pnpm — you told me yesterday."   <- no re-asking, ever
```

No server. No account. No embedding provider. Just plain markdown files — delete the directory and that scope forgets everything.

### Why this one

- **30-second setup** — one command, zero config, works on first boot
- **Two scopes** — personal preferences cross-project (`~/.dsh/memory`) + team decisions committed with the repo (`<root>/.dsh/memory`; git/SVN/Hg roots auto-detected)
- **Lazy injection, CLAUDE.md-style** — project memories are tagged by sub-directory and only load when you work in that area; your token budget goes where you work
- **Write rules built in** — strong-evidence gate ("will this matter in a month?"), same-topic saves update in place, secrets refused on sight
- **Bounded by design** — 25KB guarded index, 200-line cap, 500 memories per scope: memory can never silently eat your context window
- **Zero dependencies, pure files** — nothing to provision, nothing to break

## Quick start

**Prerequisite**: the DSH CLI itself — `npm install -g @deepseek-ai/dsh`. From a source checkout, prefix every command with `pnpm` (e.g. `pnpm dsh ...`).

**1 · Install (one command)**

```sh
dsh plugin --profile web add @fooxe/dsh-memory        # DSH CLI installed
pnpm dsh plugin --profile web add @fooxe/dsh-memory   # from a source checkout
```

The `--profile` option is **required** and goes **before** `add` — pick the profile you actually boot (`web` for the Web UI; see `~/.dsh/profiles/` for what exists). Manual install via `npm i -g @fooxe/dsh-memory` (or `pnpm add -g @fooxe/dsh-memory`) + `dsh web --patch ./overlay/dsh-memory.cordis.yml` also works, but `plugin add` is the recommended path.

**2 · Restart DSH — the step everyone misses**

Tools register **only at service startup**. The plugin stays invisible inside an already-running session even after a successful install. Stop the service (Ctrl+C), start it again, then open a **new** chat.

**3 · Verify (30 seconds)**

Say *"Remember that I prefer pnpm over npm."* → a `memory_save` tool call appears. Open a **new** session and ask *"Which package manager do I prefer?"* → answered instantly from the injected index. `~/.dsh/memory/MEMORY.md` now exists. Inside a project, decisions land in `<project-root>/.dsh/memory/` — commit it and the whole team shares it.

### Troubleshooting (every row battle-tested on a real install)

| Symptom | Fix |
|---|---|
| `dsh: command not found` | Install the DSH CLI first — see Prerequisite |
| `required option '--profile <name>'` | It goes **before** the subcommand: `dsh plugin --profile web add ...` |
| pnpm `ERR_P..._STORE: Unexpected store location` | Your terminal pnpm differs from DSH's bundled one (11.7.0). Delete the whole profile dir (`~/.dsh/profiles/web`) and re-run `plugin add` — it rebuilds cleanly from scratch |
| Installed + restarted, still no memory tools | Watch startup logs for `warning: ... did not activate`, and run `dsh --profile web --dump-config \| grep fooxe` to confirm the entry is in the tree; file an issue with the log if the warning persists |
| `ERR_PNPM_IGNORED_BUILDS` after install | Harmless for this plugin (zero native deps); run `pnpm approve-builds` in the profile dir to clear it |
| `plugin add` installs an **old version** (e.g. 0.7.2) | Your default registry (a mirror) lags behind npmjs. Pin explicitly: `npx pnpm@11.7.0 add @fooxe/dsh-memory@latest --registry=https://registry.npmjs.org` in the profile dir, or make it permanent by adding `@fooxe:registry=https://registry.npmjs.org` to `~/.npmrc` |

## Innovations

**1. Two-level scopes — cross-project, zero confusion**

- **User scope** (`~/.dsh/memory`): personal preferences and habits, stored once, available in *every* project. Stop re-explaining "I prefer pnpm" in each repo.
- **Project scope** (`<project-root>/.dsh/memory`): decisions and conventions stored *inside* their own project — any VCS (git / SVN / Mercurial) or a plain folder works; commit the directory with your version control and the whole team shares it automatically.
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
| `memory_save` | Save a durable memory; scope defaults to project inside a detected project root, user elsewhere |
| `memory_search` | Case-insensitive keyword search across both scopes (ids, titles, tags, content) |
| `memory_read` | Read one full memory (Claude Code contract fields) |
| `memory_list` | Recent memories per scope, newest first |

Tool descriptions embed proactive-save guidance — preferences, decisions and key facts get saved without being asked; secrets never do.

**Write rules (v0.5, ported from Claude Code / Gemini CLI practice):**
- **Strong-evidence default** — before saving, the model asks "will this still matter a month from now?"; unsure → skip (memory noise costs more than gaps)
- **Dedupe-and-update** — saving an existing topic updates that memory in place (content replaced, timestamp refreshed) instead of appending a duplicate
- **Dated index lines** — every MEMORY.md entry carries `YYYY-MM-DD`, so the model can reason fresh-vs-stale at injection time
- **Secret redaction** — credentials/tokens/passwords are never saved; the model refuses and says so

## Memory logic — when · what · which scope

**When to save** (the model judges as information appears): a preference or correction is stated → save now (corrections are the highest-value memories); a decision is made → save; a key number/ID appears → save; an error + fix closes → save. Strong-evidence gate (v0.5): ask "will this still matter in a month?" — if unsure, skip; memory noise costs more than memory gaps.

**Never saved**: secrets / tokens / passwords (refused, out loud), transient state, anything directly readable from the repo, unconfirmed guesses.

**Which scope** — the one-line test: is this fact about *the person* or about *this project*?

| User scope `~/.dsh/memory` | Project scope `<project-root>/.dsh/memory` |
|---|---|
| Personal preferences (pnpm, Chinese comments) | Technical decisions (A over B, because C) |
| Working habits (test before commit) | Conventions (layout, naming, build commands) |
| Cross-project lessons | Key numbers / IDs (ports, servers, app IDs) |
| Communication style | Anything the team should share through the repo |

Portability test: still true in a different project? → user scope; only true here → project scope.

**Path-tagged memories (v0.6, CLAUDE.md-style lazy injection)**: project-scope memories are automatically tagged with the sub-directory they were saved in. Root-level (untagged) memories always inject into the system prompt; path-tagged memories only inject when the session's working directory falls inside that path — "you see memories for where you work", exactly like nested CLAUDE.md files. The `path` parameter on `memory_save` also accepts an explicit override.

**Two-stage visibility (v0.7)**: nothing is silently hidden — the injected index always states how many path-tagged memories exist outside the current working area (e.g. `+3 more tagged to other areas of this project — memory_search surfaces them.`), so the model knows to search on demand and pays context cost only when needed.

## Layered scoping — how the project root is decided

Two physically isolated stores that can never mix: user `~/.dsh/memory` and project `<project-root>/.dsh/memory`. The root is auto-detected by a five-level chain, priority = explicitness (the clearest signal wins):

1. `DSH_MEMORY_PROJECT_DIR` env override (explicit user intent)
2. An existing `.dsh/memory` marker above (our own past anchor — supports nested sub-project scopes)
3. Any VCS root above: `.git` / `.svn` / `.hg` (SVN and Mercurial projects anchor correctly on first use)
4. The host workspaceRegistry (DSH official project registry, async refinement)
5. The current directory itself (VCS-less projects get their own scope)

Guard: `$HOME`, `/` and `/tmp` never become a scope — a dotfiles `~/.git` cannot turn home into one giant shared bucket. Better no isolation than wrong isolation.

## Storage layout

```
~/.dsh/memory/                      <- user scope (personal, cross-project)
|-- MEMORY.md                      <- guarded index, newest first
|-- memories/20261004-181500-prefer-pnpm.md
<project-root>/.dsh/memory/      <- project scope (team-shared)
```

Hosts without the `systemPrompt` service simply skip auto-injection — all four tools keep working.

## Verification

Three levels, all runnable from the repo:

```sh
npm install && npm run build && npm test   # 22 tests, zero type errors
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

> 你的 DSH agent 每次开会话都是"初次见面"。
> 装上 dsh-memory，它记得你。

受够了每个项目都要重新解释一遍"我用 pnpm"？上周定的架构决策这周又要从头讲？`dsh-memory` 给 agent 装上持久记忆：信息出现时**自动存下重要的东西**（偏好、项目决策、关键数字、经验教训），**之后每次会话开场自带这些记忆**。

装完 30 秒后是这个样子：

```text
会话 1   你："记住——这个项目用 pnpm，不用 npm。"
         Agent：memory_save 已保存

会话 2   你："我们用什么包管理器？"
         Agent："pnpm——你昨天告诉我的。"   <- 从此不用重复解释
```

无服务端、无账号、无 embedding——只有纯 markdown 文件，删掉目录就是彻底遗忘。

### 为什么选它

- **30 秒装好**——一条命令、零配置、开箱即用
- **双记忆域**——个人偏好跨项目通用（`~/.dsh/memory`）+ 团队决策随版本库提交共享（`<项目根>/.dsh/memory`；git/SVN/Hg 根自动检测）
- **按需注入（CLAUDE.md 式）**——项目记忆带子目录标签，只在对应区域工作时加载，token 花在刀刃上
- **写入规则内建**——强证据门槛（"一个月后还有用吗？"）、同主题原地更新、密钥一律拒存
- **天生防膨胀**——25KB 索引护栏 + 200 行上限 + 每域 500 条：记忆永远不会悄悄吃掉上下文窗口
- **零依赖纯文件**——没有要部署的、没有会坏的

## 快速开始

**前置**：先装 DSH 本体——`npm install -g @deepseek-ai/dsh`。从源码检出运行的话，每条命令加 `pnpm` 前缀（如 `pnpm dsh ...`）。

**第 1 步 · 安装（一条命令）**

```sh
dsh plugin --profile web add @fooxe/dsh-memory        # 已装 DSH CLI
pnpm dsh plugin --profile web add @fooxe/dsh-memory   # 源码检出方式
```

`--profile` **必填**且放在 `add` 前面——填你实际启动的 profile（Web 界面就是 `web`；已有哪些看 `~/.dsh/profiles/` 目录）。手动方式 `npm i -g @fooxe/dsh-memory`（或 `pnpm add -g @fooxe/dsh-memory`）+ `dsh web --patch ./overlay/dsh-memory.cordis.yml` 也可以，但推荐 `plugin add`。

**第 2 步 · 重启 DSH（最容易漏的一步）**

工具**只在服务启动那一刻注册**——装完后运行中的会话里看不到插件。把服务 Ctrl+C 停掉、重新启动、再**开新会话**。

**第 3 步 · 验证（30 秒）**

说一句*"记住我喜欢 pnpm，不用 npm"* → 出现 `memory_save` 工具调用。**新开会话**问*"我喜欢什么包管理器？"* → 直接答出 = 全链路通了。`~/.dsh/memory/MEMORY.md` 文件同时出现。在项目里保存的决策落在 `<项目根>/.dsh/memory/`——提交版本库全组共享。

### 安装排障（每一行都来自真实安装实测）

| 症状 | 解法 |
|---|---|
| `dsh: command not found` | DSH 本体没装，看前置步骤 |
| `required option '--profile <name>'` | 参数放在子命令**前面**：`dsh plugin --profile web add ...` |
| pnpm `ERR_P..._STORE: Unexpected store location` | 你终端的 pnpm 和 DSH 自带的（11.7.0）版本不一致——把整个 profile 目录（`~/.dsh/profiles/web`）删掉重跑 `plugin add`，全新重建即可 |
| 装了也重启了还是没有记忆工具 | 看启动日志有没有 `warning: ... did not activate`，并跑 `dsh --profile web --dump-config \| grep fooxe` 确认条目在插件树里；warning 仍在就把日志发 issue |
| 安装后报 `ERR_PNPM_IGNORED_BUILDS` | 对本插件无害（零原生依赖）；在 profile 目录跑 `pnpm approve-builds` 清掉即可 |
| `plugin add` 装到**旧版本**（如 0.7.2） | 默认源（镜像）同步滞后。在 profile 目录用官方源显式安装：`npx pnpm@11.7.0 add @fooxe/dsh-memory@latest --registry=https://registry.npmjs.org`；或一劳永逸——`~/.npmrc` 加一行 `@fooxe:registry=https://registry.npmjs.org` |

## 创新点

**1. 分层作用域——跨项目、零混乱**

- **用户级**（`~/.dsh/memory`）：个人偏好和习惯，存一次，*所有项目*通用。不用每个仓库重新解释"我用 pnpm"
- **项目级**（`<项目根>/.dsh/memory`）：决策和约定存在*它所属的项目里*——任意 VCS（git / SVN / Mercurial）或纯本地目录均可；随版本库提交，自动共享给全组
- **两级永不混淆**：A 项目的架构决策不会漏进 B 项目，你的个人风格却处处跟随。作用域自动检测——项目内默认存项目级，项目外存用户级（检测链见下方「分层逻辑」）

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
| `memory_save` | 保存持久记忆；项目内默认存项目级，否则存用户级 |
| `memory_search` | 大小写不敏感关键词检索（id/标题/标签/正文，跨双域） |
| `memory_read` | 读完整记忆（Claude Code 契约字段） |
| `memory_list` | 双域最近记忆列表（新→旧） |

工具描述内置主动保存指引——偏好、决策、关键数字不用吩咐就存，密钥永不存。

工具描述内置主动保存指引——偏好、决策、关键数字不用吩咐就存，密钥永不存。

**写入规则（v0.5，移植自 Claude Code / Gemini CLI 实践）：**
- **强证据默认**——存前自问“一个月后还有用吗？”，不确定就跳过（记忆噪音比缺口更贵）
- **去重更新**——同主题再存 → 原地更新该记忆（内容替换、时间戳刷新），不追加重复
- **日期索引**——MEMORY.md 每条带 YYYY-MM-DD，注入时模型可推理新旧
- **秘密脱敏**——凭据/令牌/密码永不入库，模型拒绝并明说

## 记忆逻辑——何时记 · 记什么 · 记哪级

**何时记**（模型在信息出现时自动判断）：用户表达偏好或纠正 → 立即记（纠正是最高价值记忆）；决策诞生（选 A 弃 B，因为 C）→ 立即记；关键数字/ID 出现 → 立即记；踩坑+解法闭环 → 立即记。强证据门槛（v0.5）：“一个月后还有用吗？”——不确定就不记，噪音比缺口更贵。

**永不记**：密钥/令牌/密码（拒绝并明说）、临时状态、代码里直接能读到的、未证实的猜测。

**记哪级**——一句话判定：这条信息是关于“这个人”还是关于“这个工程”？

| 记用户级 `~/.dsh/memory` | 记项目级 `<项目根>/.dsh/memory` |
|---|---|
| 个人偏好（我用 pnpm、注释用中文） | 技术决策（用 A 方案，因为 C） |
| 工作习惯（先跑测试再提交） | 项目约定（目录结构、命名规范、构建命令） |
| 跨项目经验（“这类库都有 X 坑”） | 关键数字/ID（端口、服务器、AppID） |
| 沟通风格 | 一切该随版本库共享给团队的东西 |

可移植性测试：换个项目这条还成立吗？成立 → 用户级；不成立 → 项目级。

**路径标签记忆（v0.6，CLAUDE.md 式按需注入）**：项目级记忆自动记录保存时所在的子目录。根级（无标签）记忆始终注入系统提示词；带路径标签的记忆只在会话工作目录落在该路径内时才注入——“你在哪里工作，就看到哪里的记忆”，与嵌套 CLAUDE.md 完全同理。`memory_save` 的 `path` 参数也支持显式指定。

**两段式可见性（v0.7）**：没有任何记忆被静默隐藏——注入的索引始终写明当前工作区域之外还有多少条路径标签记忆（如 `+3 more tagged to other areas of this project — memory_search surfaces them.`），模型知道可按需搜索，只在真正需要时支付上下文成本。

## 分层逻辑——项目根如何判定

两个物理隔离的存储域，永不混淆：用户级 `~/.dsh/memory`（个人记忆，跨所有项目）+ 项目级 `<项目根>/.dsh/memory`（团队记忆，随版本库共享，git/SVN/Mercurial 或纯目录均可）。

项目根自动判定——五级检测链，优先级 = 显式性（越明确的信号越优先）：

1. `DSH_MEMORY_PROJECT_DIR` 环境变量（用户显式指定）
2. 向上找已存在的 `.dsh/memory` 标记（自标识锚点，支持嵌套子项目）
3. 向上找任意 VCS 根：`.git` / `.svn` / `.hg`（SVN、Mercurial 首次使用即正确锚定）
4. 宿主 workspaceRegistry（DSH 官方项目注册表，异步精化）
5. 当前目录兜底（无 VCS 项目也拥有自己的作用域）

护栏：`$HOME`、`/`、`/tmp` 永不成为作用域——dotfiles 玩家的 `~/.git` 无法把家目录变成巨型混合桶。宁可少隔离，不可错隔离。

## 验证体系

```sh
npm install && npm run build && npm test   # 22 项测试，0 类型错误
```

dsh-memory 与 DSH 官方的 MCP 记忆方案完全共存——按工作流任选，或两者同用。

## 协议

MIT。与 DeepSeek、Anthropic 无关联。
