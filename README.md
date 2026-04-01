<div align="center">

# ⚡ Digest

**The agent harness that doesn't explore — it already knows.**

[![TypeScript](https://img.shields.io/badge/TypeScript-2,700_LOC-3178C6?logo=typescript&logoColor=white)](https://github.com/jshph/digest)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![npm](https://img.shields.io/npm/v/@jshph/digest?color=cb3837&logo=npm)](https://www.npmjs.com/package/@jshph/digest)

`8ms vault lookup` · `2 LLM turns` · `5-8K tokens per response` · `runs on 3B-9B local models`

</div>

---

```bash
export OPENAI_API_KEY=sk-or-...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
npx @jshph/digest ~/your-vault --provider openai --model qwen/qwen3.5-9b --router-model mistralai/ministral-3b-2512
```

General-purpose agents burn 60-90K tokens exploring a knowledge base — grep, read, decide, repeat. Digest replaces that explore loop with [Enzyme](https://github.com/jshph/enzyme-rust)'s pre-computed semantic index: an 8ms vector lookup against catalyst questions your vault has already generated. The model gets relevant context before it starts thinking.

~2,700 lines of TypeScript. Runs on local 3B-9B models. Works with Obsidian vaults.

## Why explore-then-respond is expensive

A typical agent exploring a personal knowledge base burns **60,000-90,000 tokens** across 5-10 LLM round trips — the model decides to search, reads results, decides to search *again*, reads more results, and eventually synthesizes. The system prompt alone is often 15,000-20,000 tokens of tool definitions and behavioral instructions. By the time it responds, you've waited 30-60 seconds and consumed the equivalent of a short novel in tokens.

Digest's total budget for a complete response is **5,000-8,000 tokens** in 2 turns. Not because it does less — because the expensive work already happened.

The key insight: [Enzyme](https://github.com/jshph/enzyme-rust) pre-computes a semantic index of your vault at "compile time" — extracting entities, generating catalyst questions, computing similarity vectors. This is the knowledge graph equivalent of compiling source code into a binary. At runtime, an 8ms `enzyme catalyze` vector lookup replaces what would be 60K+ tokens of explore-mode searching.

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

At query time, `enzyme catalyze "your question"` is an **8ms vector lookup** against pre-computed similarities — no LLM call, no token cost. It returns catalyst questions, entity names, and content excerpts ranked by conceptual relevance.

```
Explore-mode agent (60-90K tokens, 5-10 turns):
  LLM → "I should search" → search → results → "I should search more"
  → search → results → "now I can answer" → response

Digest with Enzyme:
  Open-ended query (prefetch only, ~5K tokens, 2 turns):
    enzyme catalyze (8ms) → routing signal (~150 tokens)
    → router: PassThrough → main model responds from vault overview

  Specific query (prefetch + tools, ~8K tokens, 2 turns):
    enzyme catalyze (8ms) → routing signal (~150 tokens)
    → router: VaultSearch × 3 (~2-3K tokens each) → main model synthesizes
```

The catalysts serve a dual purpose beyond retrieval:

1. **Routing signal** — catalyst questions and entity names injected as a ~150-token prefetch tell the model what the vault knows about this topic. On open-ended queries ("yo", "what's on my mind"), this is enough — the router calls PassThrough and the main model responds directly from the vault overview (total: ~5K tokens, 1.9s)
2. **Familiarity indicator** — high-relevance catalysts mean the user has been thinking about this; no matches mean it's new territory. The model calibrates accordingly
3. **Search targeting** — when the router does search, the entity names from the prefetch guide what it searches for. Each VaultSearch call returns 2,000-3,000 tokens of content excerpts — substantial context, but targeted rather than exploratory

Real numbers from a "let's explore that" follow-up (OpenRouter, Qwen 9B + Ministral 3B):
- 3 parallel VaultSearch calls: 2,442 + 2,918 + 1,962 tokens of results
- Router decision: 830ms, 71 output tokens
- Synthesis: 7.3s to first token, ~600 tokens of response
- Total: ~8K tokens consumed, 2 turns

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

| Component | Explore-mode agent | Digest |
|-----------|-------------------|--------|
| System prompt + instructions | 15,000-20,000 | ~2,800 (with 20-entity petri) |
| Tool definitions | 6,000-8,000 | ~600 |
| Search results per response | 10,000-30,000 (multiple explore rounds) | 6,000-8,000 (3 parallel VaultSearch) |
| Tokens consumed per response | 60,000-90,000 | 5,000-8,000 |
| **Minimum viable context window** | **32K-128K** | **8K** (open-ended) / **32K** (deep search) |

Digest's base overhead is ~3,400 tokens (system + tools). On a 32K window with a 20-entity vault, that leaves ~29K for search results and conversation. The key difference isn't just overhead size — it's that enzyme's 8ms vector lookup replaces what would be multiple LLM-decided search rounds, each costing a full inference pass.

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
# OpenRouter (recommended — Qwen 32B main + Ministral 3B router)
export OPENAI_API_KEY=sk-or-...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
npx @jshph/digest ~/vault --provider openai --model qwen/qwen3.5-9b \
  --router-model mistralai/ministral-3b-2512

# Anthropic (uses Claude Code auth or ANTHROPIC_API_KEY)
npx @jshph/digest ~/vault

# LM Studio (local)
npx @jshph/digest ~/vault --provider lmstudio --model qwen/qwen3.5-9b \
  --router-model qwen/qwen3.5-3b --max-context 32768

# Debug logging
DEBUG=1 npx @jshph/digest ~/vault
```

Auth resolves automatically: `ANTHROPIC_API_KEY` env var, or Claude Code's OAuth token from macOS Keychain if you're logged in.

## Read the code

The codebase is designed to be read top-to-bottom as a reference for building minimal agents:

1. **[src/core/types.ts](src/core/types.ts)** — Every type in the system. Start here.
2. **[src/core/agent.ts](src/core/agent.ts)** — The agent loop: prefetch, router/synthesizer split, KV cache warming.
3. **[src/context/prefetch.ts](src/context/prefetch.ts)** — Automatic vault context retrieval via Enzyme catalyze.
4. **[src/tools/text-search.ts](src/tools/text-search.ts)** — Entity search (#tags, [[wikilinks]]) via grep.
5. **[src/tools/vault-search.ts](src/tools/vault-search.ts)** — Semantic search via Enzyme catalyze (tool version for router).
6. **[src/context/compact.ts](src/context/compact.ts)** — Conversation summarization for small context windows.
7. **[src/core/providers/anthropic.ts](src/core/providers/anthropic.ts)** — Anthropic API with cache block support.
8. **[src/core/providers/openai.ts](src/core/providers/openai.ts)** — OpenAI-compatible provider with KV cache warming.
9. **[src/prompt/system.ts](src/prompt/system.ts)** — Cache-aware system prompt construction.
10. **[src/core/debug.ts](src/core/debug.ts)** — JSONL debug logging for prompt tuning.

## What Digest is not

Digest is an agent *harness* — the runtime that runs an agent loop. It's not a protocol (A2A, MCP, ACP), not a framework (LangChain, CrewAI), and not a CLI product. The REPL is a test harness. The real surface is the SDK:

```typescript
import { Agent, createAnthropicProvider, buildSystemPrompt, createEnzymePrefetch } from '@jshph/digest'
```

It's pluggable but Enzyme-first. The `Tool` and `LLMProvider` interfaces are clean enough to swap backends. The prefetch hook accepts any async function that returns context. But the architecture is designed around the assumption that a semantic index (Enzyme) has already done the expensive work of understanding the vault — the agent just reasons about the results.
