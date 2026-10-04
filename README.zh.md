# dsh-memory（DSH 的 Claude Code 式记忆插件）

**给 DeepSeek Harness 装上 Claude Code 同款记忆——用户级+项目级分层存储、会话启动自动注入、纯文件零依赖。**

DSH 官方的记忆方案默认关闭、要自配第三方 MCP 服务、检索原始（子串匹配）、模型还经常忘记调用。本插件反其道而行：把 Claude Code 验证过的记忆架构做成一等公民。

## 设计原则（对照 Claude Code）

| 原则 | 实现 |
|---|---|
| MEMORY.md 索引 | 紧凑、可直读、最新在前 |
| 索引护栏 | 硬上限 200 行 / 25 KB——记忆永远不能悄悄吃掉上下文窗口 |
| **会话启动自动注入** | **v0.2.0：通过 `ctx.systemPrompt` 把 MEMORY.md 索引注入系统提示词——每个会话醒来就带着记忆，Claude Code 同款体验** |
| 自动记忆行为 | `memory_save` 工具描述内置主动保存指引（偏好、决策、关键事实；不存密钥） |
| 存储有界 | 最多 500 条记忆，超限自动修剪最旧的 |
| 零依赖 | 无服务、无 embedding、无账号。纯文件存于 `~/.dsh/memory`（用户级）+ `<git根>/.dsh/memory`（项目级） |

## 四个工具

| 工具 | 作用 |
|---|---|
| `memory_save` | 保存持久记忆并更新护栏索引 |
| `memory_search` | 大小写不敏感的关键词检索（id/标题/标签/正文） |
| `memory_read` | 按 id 读取完整记忆 |
| `memory_list` | 列出最近记忆（新→旧） |

## 安装启用

```sh
npm install -g dsh-memory
dsh web --patch ./overlay/claude-memory.cordis.yml
```

跨次运行保留：把 `overlay/claude-memory.cordis.yml` 里的 `insert` 补丁合并进 `$DSH_HOME/cordis.patch.yml`。

存储：用户级 `~/.dsh/memory/`（可用 `DSH_MEMORY_USER_DIR` 覆盖）；项目级 `<git根>/.dsh/memory/`（随 git 提交）。删哪个目录就清哪个作用域。

## 状态说明

DSH 处于 developer preview，可能有不兼容变更；本插件严格遵循 `@deepseek-ai/dsh-tool-schedule` 的 `defineTool` / `apply(ctx)` / `inject: ['tools']` 结构。MIT 协议。

> 与 DeepSeek、Anthropic 均无关联；"Claude Code 式"仅描述记忆设计思想。
