# Scribe

A token-efficient agent harness for writing and thinking. ~2,700 lines of TypeScript. Designed for small context windows (8K-32K), local models, and Obsidian vaults.

## The problem with explore-then-respond agents

A general-purpose agent exploring a knowledge base burns **60,000-90,000 tokens** across its explore loop — file searches, grep calls, reading results, deciding what to search next. The initial system prompt alone is often 15,000-20,000 tokens of tool definitions and behavioral instructions. By the time the agent responds, you've consumed the equivalent of a short novel in tokens and waited through 3-5 LLM round trips.

Scribe's total budget for a complete response is under **8,000 tokens**. Not because it does less — because the expensive work happens *before* the model thinks.

The key insight: [Enzyme](https://github.com/jshph/enzyme-rust) pre-computes a semantic index of your vault at "compile time" — extracting entities, generating catalyst questions, computing similarity vectors. This is the knowledge graph equivalent of compiling source code into a binary. At runtime, a 200ms `enzyme catalyze` call replaces what would be 60K+ tokens of explore-mode searching.

Three ideas make this work:

1. **Compile-time knowledge indexing via Enzyme** — the vault is already understood before the agent starts
2. **Prefetch before the LLM sees the prompt** — relevant context is injected, not discovered through tool calls
3. **A two-model router/synthesizer split** — each model does only what it's good at

## How Enzyme changes the economics

The standard agent pattern for knowledge retrieval is **explore at runtime**: the LLM decides to search, reads results, decides to search again, reads more, and eventually synthesizes. Each search is a tool call that costs a full LLM round trip to *decide*, plus tokens for the results. On a vault with hundreds of notes, an explore loop can burn 60-90K tokens and 30-60 seconds across 5-10 turns.

Enzyme inverts this by moving retrieval intelligence to **compile time**. When you run `enzyme init` or `enzyme refresh`, it:

- Extracts entities (tags, wikilinks, folders) from your vault
- Generates **catalyst questions** — AI-written thematic probes anchored to each entity
- Pre-computes similarity vectors between catalysts and all content chunks

This is done once, outside the agent, and cached in a local SQLite database. The knowledge graph is already built when the conversation starts.

At query time, `enzyme catalyze "your question"` is a **200ms vector lookup** — no LLM call, no token cost. It returns the catalyst questions that resonate with the query and the entities they're anchored to.

```
Explore-mode agent (60-90K tokens, 5-10 turns):
  LLM → "I should search" → search → results → "I should search more"
  → search → results → "now I can answer" → response

Scribe with Enzyme (4-8K tokens, 1-2 turns):
  enzyme catalyze (200ms, 0 tokens) → inject routing signal (~150 tokens)
  → LLM already has context → response (or 1 targeted tool call + response)
```

The catalysts serve a dual purpose beyond retrieval:

1. **Routing signal** — catalyst questions and entity names tell the model what the vault already contains about this topic, so it knows whether to search deeper (TextSearch for a specific `#tag`) or respond directly
2. **Familiarity indicator** — high-relevance catalysts mean the user has been thinking about this; no matches mean it's new territory. The model calibrates its response accordingly
3. **Token efficiency** — catalysts are ~150 tokens of structured signal, vs ~2,000+ tokens of raw file content that explore-mode agents inject

On a conceptual query ("What tensions am I holding?"), the prefetch carries the entire response — zero tool calls, one LLM turn, under 2,000 input tokens total.

On an entity query ("What's tagged #founding?"), the prefetch provides routing context and the model calls TextSearch for the specific tag — two turns, under 5,000 tokens total.

## Architecture

### The agent loop

```
prompt(text)
  → clear old tool results (stabilize KV cache prefix)
  → prefetch: enzyme catalyze on recent messages
  → inject catalyst questions + entity names as context
  → router model: decide tools or pass through
  → if tools: execute in parallel, then synthesis model responds
  → if pass through: synthesis model responds directly from vault overview
  → warm KV cache for next prompt
```

Two turns max. No while-loop iteration. The router (a small/fast model) handles structured decisions; the main model (larger, slower) handles prose synthesis.

### Token budget

| Component | Explore-mode agent | Scribe |
|-----------|-------------------|--------|
| System prompt + instructions | 15,000-20,000 | ~660 |
| Tool definitions | 6,000-8,000 | ~600 |
| Search results per query | 2,000-5,000 per round trip | ~150 (catalyst routing signal) |
| Tokens consumed per response | 60,000-90,000 | 2,000-5,000 |
| **Minimum viable context window** | **32K-128K** | **8K** |

Scribe's total overhead is ~1,410 tokens. That leaves ~6,700 tokens on an 8K window for conversation — enough for prefetched context, the user's message, and a substantive response. An explore-mode agent needs 32K just for the *overhead* before any user content.

### Cache-aware prompt structure

The system prompt is split into blocks with explicit cache hints:

```
CACHED (stable across all turns):
  [single block] identity + tool guidance + context rules + enzyme petri overview

UNCACHED (may change):
  memory (MEMORY.md)
  date/env
```

For Anthropic's API, a `cache_control` breakpoint on the cached block enables KV cache reuse across turns. For local models (llama.cpp, LM Studio), the append-only message strategy during the tool-call loop ensures the inference server's KV cache stays valid — verified via debug logging with prefix stability checks.

### Router/synthesizer split

When running two models (e.g., 3B router + 9B synthesizer on Apple Silicon):

| | Router (3B) | Synthesizer (9B) |
|---|---|---|
| Purpose | Decide: search or pass through | Write the response |
| Tools | VaultSearch, TextSearch, ReadFile, WriteFile, PassThrough | None |
| Output | Tool-call JSON only | Prose only |
| Speed | ~400ms (pass through), ~2s (tools) | ~5s |

The synthesizer never sees tool definitions on the response turn. This prevents it from re-searching instead of answering — a common failure mode when small models have tools available.

### KV cache warming

Three points where the cache is warmed:
1. **Startup**: system prompt sent to both models before the user types
2. **During router turn**: main model warms its prefix in parallel while the router runs
3. **After response**: stubbed prefix sent so the next prompt gets a cache hit immediately

On local inference (LM Studio), this reduced total latency from 2:25 to 1:34 for a typical search query.

## Tools

| Tool | Purpose | When |
|------|---------|------|
| `VaultSearch` | Semantic search via `enzyme catalyze` | Router finds specific content by concept |
| `TextSearch` | Grep for `#tags` and `[[wikilinks]]` | User references vault entities explicitly |
| `ReadFile` | Read full note by path | Need more than excerpts |
| `WriteFile` | Write/create a note | Drafting |
| `PassThrough` | Signal: no search needed | Open-ended or conversational prompts |

TextSearch is strictly for structural vault entities — tags and wikilinks that exist verbatim in markdown. It never searches for phrases or concepts. That distinction is enforced in the tool description (one sentence: "Find notes by #tag or [[wikilink]]. Omit # for tags. Never use for phrases or concepts.") and validated through prompt tuning against Haiku-class models.

## Running it

```bash
# Anthropic (uses Claude Code auth or ANTHROPIC_API_KEY)
scribe ~/vault

# LM Studio (local)
scribe ~/vault --provider lmstudio --model qwen/qwen3.5-9b --max-context 32768

# Two-model split (router + synthesizer, both local)
scribe ~/vault --provider lmstudio --model qwen/qwen3.5-9b \
  --router-model qwen/qwen3.5-3b --max-context 32768

# Debug logging
SCRIBE_DEBUG=1 scribe ~/vault
```

Auth resolves automatically: `ANTHROPIC_API_KEY` env var, or Claude Code's OAuth token from macOS Keychain if you're logged in.

## Read the code

The codebase is designed to be read top-to-bottom as a reference for building minimal agents:

1. **[src/core/types.ts](../src/core/types.ts)** — Every type in the system. Start here.
2. **[src/core/agent.ts](../src/core/agent.ts)** — The agent loop: prefetch, router/synthesizer split, KV cache warming.
3. **[src/context/prefetch.ts](../src/context/prefetch.ts)** — Automatic vault context retrieval via Enzyme catalyze.
4. **[src/tools/text-search.ts](../src/tools/text-search.ts)** — Entity search (#tags, [[wikilinks]]) via grep.
5. **[src/tools/vault-search.ts](../src/tools/vault-search.ts)** — Semantic search via Enzyme catalyze (tool version for router).
6. **[src/context/compact.ts](../src/context/compact.ts)** — Conversation summarization for small context windows.
7. **[src/core/providers/anthropic.ts](../src/core/providers/anthropic.ts)** — Anthropic API with cache block support.
8. **[src/core/providers/openai.ts](../src/core/providers/openai.ts)** — OpenAI-compatible provider with KV cache warming.
9. **[src/prompt/system.ts](../src/prompt/system.ts)** — Cache-aware system prompt construction.
10. **[src/core/debug.ts](../src/core/debug.ts)** — JSONL debug logging for prompt tuning.

## Design documents

| Doc | Contents |
|-----|----------|
| [01 — Claude Code Anatomy](01-claude-code-anatomy.md) | What's inside 512K lines. What's worth borrowing. |
| [02 — Pi Agent Analysis](02-pi-agent-analysis.md) | The minimal agent loop pattern (1,859 lines). |
| [03 — Enzyme as Context Engine](03-enzyme-as-context-engine.md) | How pre-computed vault context replaces runtime search. |
| [04 — Architecture Proposal](04-scribe-architecture-proposal.md) | Layers, tools, token budgets, prefetch pattern. |
| [05 — Compaction Strategy](05-compaction-strategy-for-small-context.md) | Context compression tuned for 8K-32K. |
| [06 — Prompt Coercion Audit](06-what-to-cut-from-claude-code.md) | Line-by-line token reduction analysis. |
| [07 — SDK-First Design](07-sdk-first-design.md) | Harness, not CLI. Integration over isolation. |
| [08 — Cache Architecture](08-cache-architecture.md) | KV cache strategy, minimum thresholds, real-world findings. |
| [09 — Positioning & Protocols](09-positioning-and-protocols.md) | Where Scribe sits vs MCP, A2A. Auth strategy. |
| [10 — Prompt Tuning Log](10-prompt-tuning-log.md) | Debug findings: tool misuse, cache misses, prompt fixes. |
| [11 — Multi-Provider Support](11-multi-provider-support.md) | OpenAI-compatible endpoints, CLI args, local models. |
| [12 — Router/Synthesizer](12-router-synthesizer-architecture.md) | Two-model split, PassThrough, KV cache warming. |

## What Scribe is not

Scribe is an agent *harness* — the runtime that runs an agent loop. It's not a protocol (A2A, MCP, ACP), not a framework (LangChain, CrewAI), and not a CLI product. The REPL is a test harness. The real surface is the SDK:

```typescript
import { Agent, createAnthropicProvider, buildSystemPrompt, createEnzymePrefetch } from 'scribe'
```

It's pluggable but Enzyme-first. The `Tool` and `LLMProvider` interfaces are clean enough to swap backends. The prefetch hook accepts any async function that returns context. But the architecture is designed around the assumption that a semantic index (Enzyme) has already done the expensive work of understanding the vault — the agent just reasons about the results.
