# dsh-memory

**Hierarchical Claude Code-style persistent memory for DeepSeek Harness — user + project scopes, session-start auto-injection, pure files, zero dependencies.**

Brings the memory architecture Claude Code popularized to DSH: a `MEMORY.md` index with hard size guards, one markdown file per memory, and proactive-save tool guidance so the agent remembers what matters across sessions.

## Why

DSH's official memory story delegates to third-party MCP servers: off by default, provisioning on you, substring search at best, and the model often forgets to call the tools. This plugin takes the opposite trade — memory as a first-class built-in, following the design Claude Code proved at scale:

| Principle | Implementation |
|---|---|
| MEMORY.md index | Compact, always-readable, newest first |
| Index guards | Hard caps: 200 lines / 25 KB — memory can never silently eat the context window |
| **Session-start auto-injection** | **v0.2.0: the MEMORY.md index is injected into the system prompt via `ctx.systemPrompt` — every session wakes up with its memories, Claude Code style** |
| Auto-memory behavior | `memory_save` description carries proactive-save guidance (preferences, decisions, key facts — no secrets) |
| Bounded store | 500 memories max; oldest pruned automatically |
| Zero dependencies | No server, no embedding provider, no account. Plain files under `~/.dsh/memory` (user) and `<git-root>/.dsh/memory` (project) |

## Tools

| Tool | What it does |
|---|---|
| `memory_save` | Save a durable memory + update the guarded index |
| `memory_search` | Case-insensitive keyword search across ids, titles, tags, content |
| `memory_read` | Read one full memory by id |
| `memory_list` | Recent memories, newest first |

## Install

```sh
npm install -g dsh-memory
dsh web --patch ./overlay/dsh-memory.cordis.yml
```

To persist across runs, merge the `insert` patch from `overlay/dsh-memory.cordis.yml` into `$DSH_HOME/cordis.patch.yml`.

Storage: user scope `~/.dsh/memory/` (override with `DSH_MEMORY_USER_DIR`); project scope `<git-root>/.dsh/memory/`, committed to git. Delete a scope's directory to forget that scope.

## Status

DSH is in developer preview with breaking changes expected; this plugin follows the `defineTool` / `apply(ctx)` / `inject: ['tools']` shape of `@deepseek-ai/dsh-tool-schedule` and pins against current peer versions. MIT.

> Not affiliated with DeepSeek or Anthropic. "Claude Code-style" describes the memory design, not the vendor.
