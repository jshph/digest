# Scribe: A Token-Efficient Writing Agent

## The Problem

Claude Code is 512K lines optimized for code editing. Its system prompt alone burns ~11K tokens — nearly filling a small local model's entire context window. For a writing/thinking agent:

- **90% of Claude Code is irrelevant**: TUI, git, IDE bridge, code tools, security instructions, enterprise features
- **The prompt coercion is code-centric**: "The user will primarily request you to perform software engineering tasks"
- **Tool overhead is massive**: 20+ tools × ~300 tokens each = ~6,000 tokens just for tool schemas
- **Context window is assumed large**: Designed for 200K-1M token context, triggers compaction at 187K

A writing agent targeting local models (8K-32K context) needs to be radically smaller.

## Design Principles

1. **Context is king**: Every token of system prompt displaces a token of user content or vault context
2. **Enzyme does the heavy lifting**: Pre-compile context outside the model, inject only what's needed
3. **Prefetch over tool calls**: Retrieve vault context automatically before the LLM sees the prompt
4. **Minimal tool surface**: 3 tools instead of 20+
5. **Aggressive compaction**: Borrow Claude Code's approach but tune for tiny context windows
6. **SDK-first, not CLI-first**: Build an agent harness, not a terminal app

## Token Budget (actual, targeting 8K context)

| Component | Claude Code | Scribe (actual) |
|-----------|------------|-----------------|
| System prompt | ~3,000 | ~670 |
| Tool definitions | ~6,000 | ~600 (3 tools) |
| Memory/context injection | ~2,000 | ~200 (enzyme petri in system prompt) |
| Git/env status | ~800 | ~10 (just date + vault name) |
| **Base overhead** | **~12,000** | **~1,480** |
| Available for conversation | ~188K (200K) | ~6,700 (8K) |

## Architecture

### The Prefetch Pattern

The key architectural decision: vault search is NOT a tool the model calls. It runs automatically before each LLM turn.

```
BEFORE (tool-based, 2+ round trips):
  user → LLM decides to search → tool call → results → LLM responds

AFTER (prefetch, 1 round trip):
  user → enzyme catalyze runs → context injected → LLM responds immediately
```

This saves a full LLM round trip per turn. On conceptual queries, the model responds in a single turn with zero tool calls.

The prefetch strips vault syntax (#tags, [[wikilinks]]) from the query before calling catalyze, since those are entity anchors meant for grep, not semantic search.

### Layer 1: Agent Core

~290 lines (`agent.ts`). The loop:

```
prompt(text) → prefetch → manageContext → callModel → executeTool → repeat
```

Key features adapted from Pi's agent-core:
- Event system for UI integration
- Tool lifecycle (find → execute → append result)
- Context management hooks (clear old tool results, compact when needed)
- Prefetch hook (runs before first LLM call)

### Layer 2: Tools (3 total)

| Tool | Purpose | When used |
|------|---------|-----------|
| `TextSearch` | Find notes by #tag or [[wikilink]] | User references vault entities |
| `ReadFile` | Read full note by path (from TextSearch results) | Need more than excerpts |
| `WriteFile` | Write/create a note | Drafting |

Removed from earlier design:
- `VaultSearch` → replaced by automatic prefetch
- `VaultOverview` → petri output is in the system prompt (cached)
- `AskUser` → not needed (REPL handles interaction)

Total tool overhead: **~600 tokens** (vs Claude Code's ~6,000)

### Layer 3: Context Management

1. **Pre-session**: Run `enzyme petri` → inject into cached system prompt block
2. **Pre-turn**: Run `enzyme catalyze` on recent user messages → inject as context
3. **Per-turn**: Clear old tool results (keep last 2), estimate tokens
4. **Threshold**: Compact at 70% of context window (vs Claude Code's ~93%)
5. **Compaction**: Summarize older messages, keep last 2 exchanges verbatim

### Layer 4: System Prompt (cache-aware)

```
CACHED (single block, ~660 tokens):
  identity + tool guidance + context guidance + petri overview

UNCACHED:
  memory (if present)
  date/env
```

All stable content is merged into ONE cached block to maximize the chance of hitting the cache minimum threshold. See [08 — Cache Architecture](08-cache-architecture.md) for details.

### Layer 5: Auth

Resolves API key automatically:
1. `ANTHROPIC_API_KEY` env var
2. Claude Code's OAuth token from macOS Keychain

No separate auth setup needed if Claude Code is installed.

## What We Borrowed

| Feature | From | Adapted How |
|---------|------|-------------|
| Agent loop | Pi agent-core | Simplified, added prefetch hook |
| Compaction | Claude Code | Writing-focused summary prompt, lower threshold |
| Tool result clearing | Claude Code (microcompact) | Simpler count-based, not time-based |
| Cache structure | Claude Code | SystemPromptBlock with cache flag |
| Auth | Claude Code | Read OAuth token from Keychain |
| Vault search | Enzyme skill | catalyze for concepts, grep for entities |

## File Structure (actual)

```
scribe/
├── src/
│   ├── core/
│   │   ├── types.ts          # 234 lines — all types
│   │   ├── agent.ts          # 290 lines — the loop + prefetch
│   │   ├── auth.ts           #  57 lines — API key resolution
│   │   ├── debug.ts          # 140 lines — JSONL debug logging
│   │   └── providers/
│   │       └── anthropic.ts  # 258 lines — Claude API + cache blocks
│   ├── tools/
│   │   ├── text-search.ts    #  87 lines — #tag/[[wikilink]] grep
│   │   ├── read-file.ts      #  57 lines — read vault file by path
│   │   └── write-file.ts     #  52 lines — write/create vault file
│   ├── context/
│   │   ├── prefetch.ts       #  82 lines — auto enzyme catalyze
│   │   ├── compact.ts        # 124 lines — conversation summarization
│   │   ├── clearing.ts       #  44 lines — old tool result stubs
│   │   └── tokens.ts         #  43 lines — rough token estimation
│   ├── prompt/
│   │   └── system.ts         #  97 lines — cache-aware prompt blocks
│   ├── main.ts               # 178 lines — REPL test harness
│   └── index.ts              #  33 lines — SDK exports
├── docs/                     # 10 research & design documents
├── package.json
└── tsconfig.json
```

Total: **~1,700 lines** (vs 512,685 for Claude Code)
