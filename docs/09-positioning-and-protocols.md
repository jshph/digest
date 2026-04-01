# Positioning: What Scribe Is and Isn't

## What Scribe Is

Scribe is an **agent harness** — a runtime for running an LLM-powered agent loop. It's the same architectural layer as:

- [Pi's agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent) (~1,800 lines)
- [CrewAI](https://www.crewai.com) / [LangGraph](https://langchain-ai.github.io/langgraph/) (frameworks)
- Claude Code's `query.ts` + `QueryEngine.ts` (~70K lines)

All of these implement the same core loop: prompt → stream → tools → repeat. The difference is what they optimize for.

| Harness | Optimized For | Context Assumption | Lines |
|---------|--------------|-------------------|-------|
| Claude Code | Code editing, enterprise | 200K-1M tokens | ~500K |
| Pi agent-core | Multi-provider coding | Large context | ~1,800 |
| CrewAI/LangGraph | Multi-agent orchestration | Large context | Frameworks |
| **Scribe** | Writing + thinking, teaching | **8K-32K tokens** | ~1,700 |

## What Scribe Is NOT

### Not a protocol (A2A, MCP, ACP)

The 2026 agent protocol landscape:

| Protocol | Layer | What It Does | Who Made It |
|----------|-------|-------------|-------------|
| **MCP** | Tool access | Agent ↔ tools/data/APIs | Anthropic |
| **A2A** | Agent coordination | Agent ↔ agent discovery + delegation | Google / Linux Foundation |
| **ACP** | Commerce | Agent transactions + compliance | IBM (merged into A2A) |

These are **interoperability protocols** — standards for how agents talk to each other or to external systems. Scribe is the thing that *runs* an agent, which could then speak those protocols.

Relationship:
- **MCP**: Enzyme already has an MCP server (`enzyme mcp`). Scribe could consume it as a tool provider instead of shelling out to `enzyme catalyze`. Or Scribe could expose itself as an MCP server so Claude Code can call it.
- **A2A**: If you wanted multiple Scribe agents to discover and delegate to each other, you'd implement A2A's Agent Card on top. Overkill for a single-agent writing tool.
- **ACP**: Not relevant (no commerce).

### Not a CLI/TUI

Scribe is SDK-first. The REPL in `main.ts` is a test harness, not the product. The real surface area is:

```typescript
import { Agent, createAnthropicProvider, buildSystemPrompt } from 'scribe'
```

Integration points (not built in, but supported by the architecture):
- Claude Code skill (scribe as a skill Claude Code invokes)
- Obsidian plugin (via enzyme's plugin infrastructure)
- MCP server (expose vault context as MCP resources)
- Standalone REPL (the current main.ts)
- Piped I/O (`echo "query" | scribe --vault ~/vault`)

## Authentication

Scribe resolves auth automatically — no separate API key configuration if you're already using Claude Code:

1. `ANTHROPIC_API_KEY` env var (if set, used directly)
2. Claude Code's OAuth token from macOS Keychain (if `claude login` has been run)

The OAuth token stored by Claude Code works as a standard `x-api-key` header for `api.anthropic.com`. This means if you have a Claude subscription and use Claude Code, Scribe just works — same auth, same billing, no extra setup.

See `src/core/auth.ts` for the resolution logic.

## Why Not Just Use Claude Code Directly?

You could. Claude Code is a general-purpose agent. With the right CLAUDE.md, skills, and enzyme integration, it does writing work well.

But:
- Claude Code's system prompt burns ~11K tokens before you say anything
- Its 20+ tool definitions add ~6K more tokens
- That's 17K tokens of overhead — more than double an 8K context window
- Its context management assumes 200K+ tokens available
- Its compaction triggers at 93% — useless for small context
- Scribe's total overhead is ~1,500 tokens (system + 3 tools), leaving ~6,700 tokens for conversation on an 8K window

Scribe exists because **the constraints are different**. Small context windows demand different trade-offs: fewer tools, tighter prompts, more aggressive compaction, and cache-aware prompt structure. Those trade-offs are worth understanding even if you end up using Claude Code for your daily work.
