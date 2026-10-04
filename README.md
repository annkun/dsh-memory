# dsh-memory

![npm](https://img.shields.io/npm/v/dsh-memory) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22.19-green)

**Hierarchical Claude Code-style persistent memory for DeepSeek Harness — session-start auto-injection, user + project scopes, zero runtime dependencies.**

## Why

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
npm install -g @annkun/dsh-memory
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
