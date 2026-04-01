# Scribe

A reference implementation for building token-efficient LLM agents. ~1,700 lines of TypeScript that does what Claude Code does in 500K — for writing and thinking workloads on small context windows.

## Why This Exists

Claude Code is a 512K-line agent optimized for code editing on 200K-1M token contexts. Most of that is TUI, IDE integration, enterprise features, and 20+ code-editing tools. The actual agent loop — prompt, stream, tools, repeat — is buried under layers of abstraction.

Scribe extracts that loop, strips it to essentials, and rebuilds it for a different set of constraints: writing instead of coding, 8K instead of 200K, Enzyme instead of grep, and teaching clarity instead of production completeness.

## Read the Code

Start with these files in order:

1. **[src/core/types.ts](../src/core/types.ts)** — Every type in the system. Read this first.
2. **[src/core/agent.ts](../src/core/agent.ts)** — The agent loop with prefetch. The centerpiece.
3. **[src/context/prefetch.ts](../src/context/prefetch.ts)** — Automatic vault context retrieval via Enzyme catalyze.
4. **[src/tools/text-search.ts](../src/tools/text-search.ts)** — Entity search (#tags, [[wikilinks]]) via grep.
5. **[src/context/compact.ts](../src/context/compact.ts)** — How compaction works on small context.
6. **[src/core/providers/anthropic.ts](../src/core/providers/anthropic.ts)** — Provider with cache block support.
7. **[src/prompt/system.ts](../src/prompt/system.ts)** — Cache-aware system prompt construction.
8. **[src/core/auth.ts](../src/core/auth.ts)** — Resolves API key from env or Claude Code's keychain.
9. **[src/core/debug.ts](../src/core/debug.ts)** — JSONL debug logging for prompt tuning.

## Key Numbers

| | Claude Code | Scribe |
|---|---|---|
| Lines of code | 512,685 | ~1,700 |
| System prompt overhead | ~11,000 tokens | ~670 tokens |
| Tools | 20+ | 3 |
| Target context window | 200K-1M | 8K-32K |
| Compaction trigger | 93% | 70% |

## Architecture

Scribe's key innovation is the **prefetch pattern**: vault context is automatically retrieved via `enzyme catalyze` before the LLM sees the user's message. This eliminates a tool-call round trip and lets the model reason about vault content immediately.

```
user message → prefetch (enzyme catalyze) → inject context → LLM responds
                                                              ↓
                                              (may call TextSearch for #tags/[[links]])
                                              (may call ReadFile for full notes)
                                              (may call WriteFile for drafts)
```

Three query patterns, tested and tuned:

| Query type | Example | What happens | Turns |
|------------|---------|-------------|-------|
| Conceptual | "What tensions am I holding?" | Prefetch only, no tools | 1 |
| #tag | "What's tagged #founding?" | Prefetch + TextSearch | 2-3 |
| [[wikilink]] | "What's in [[open questions]]?" | Prefetch + TextSearch + ReadFile | 2-3 |

## Research Documents

| Doc | Contents |
|-----|----------|
| [01 — Claude Code Anatomy](01-claude-code-anatomy.md) | Where 512K lines go. What's bloat, what's worth borrowing. |
| [02 — Pi Agent Analysis](02-pi-agent-analysis.md) | The minimal agent loop pattern (1,859 lines). |
| [03 — Enzyme as Context Engine](03-enzyme-as-context-engine.md) | How Enzyme replaces file search tools. |
| [04 — Architecture Proposal](04-scribe-architecture-proposal.md) | Full design: layers, tools, token budgets. |
| [05 — Compaction Strategy](05-compaction-strategy-for-small-context.md) | Context compression adapted for 8K-32K. |
| [06 — Prompt Coercion Audit](06-what-to-cut-from-claude-code.md) | Line-by-line: 83% token reduction. |
| [07 — SDK-First Design](07-sdk-first-design.md) | Harness, not CLI. Integration over isolation. |
| [08 — Cache Architecture](08-cache-architecture.md) | KV cache strategy, minimum thresholds, real-world findings. |
| [09 — Positioning & Protocols](09-positioning-and-protocols.md) | Where Scribe sits vs A2A, MCP, ACP. Auth strategy. |
| [10 — Prompt Tuning Log](10-prompt-tuning-log.md) | What we learned from debug logging and iterating on prompts. |

## What Scribe Is Not

Scribe is not a protocol (A2A, MCP, ACP). It's the runtime that *runs* an agent, which could then speak those protocols. It's not a CLI or TUI — the REPL is a test harness. The real surface is the SDK: `import { Agent } from 'scribe'`.

## Reference Codebases

- Claude Code source: `/Users/joshuapham/Downloads/src/` (analyzed, not copied)
- Pi agent: `/Users/joshuapham/Hacks/pi-agent/` (cloned from badlogic/pi-mono)
- Enzyme: `/Users/joshuapham/Hacks/enzyme-rust/`
- Enzyme skill: `/Users/joshuapham/Hacks/enzyme-skill/`
