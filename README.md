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
export OPENAI_MODEL=qwen/qwen3-32b
cd ~/your-vault && npx @jshph/digest
```

General-purpose agents burn 60-90K tokens exploring a knowledge base — grep, read, decide, repeat. Digest replaces that explore loop with [Enzyme](https://www.enzyme.garden/)'s pre-computed semantic index: an 8ms vector lookup against catalyst questions your vault has already generated. The model gets relevant context before it starts thinking.

~2,700 lines of TypeScript. Works with any OpenAI-compatible endpoint. Works with Obsidian vaults.

## Why explore-then-respond is expensive

A typical agent exploring a personal knowledge base burns **60,000-90,000 tokens** across 5-10 LLM round trips — the model decides to search, reads results, decides to search *again*, reads more results, and eventually synthesizes. The system prompt alone is often 15,000-20,000 tokens of tool definitions and behavioral instructions. By the time it responds, you've waited 30-60 seconds and consumed the equivalent of a short novel in tokens.

Digest's total budget for a complete response is **5,000-8,000 tokens** in 2 turns. Not because it does less — because the expensive work already happened.

The key insight: [Enzyme](https://www.enzyme.garden/) pre-computes a semantic index of your vault at "compile time" — extracting entities, generating catalyst questions, computing similarity vectors. This is the knowledge graph equivalent of compiling source code into a binary. At runtime, an 8ms `enzyme catalyze` vector lookup replaces what would be 60K+ tokens of explore-mode searching.

Two ideas make this work:

1. **Compile-time knowledge indexing via Enzyme** — the vault is already understood before the agent starts
2. **Prefetch before the LLM sees the prompt** — relevant context is injected, not discovered through tool calls

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

Digest with Enzyme (~5-8K tokens, 2 turns):
  enzyme catalyze (8ms) → routing signal (~150 tokens)
  → model decides: tools or direct response
  → if tools: VaultSearch × 3 (~2-3K tokens each) → synthesize
  → if no tools: respond directly from vault overview
```

The catalysts serve a dual purpose beyond retrieval:

1. **Routing signal** — catalyst questions and entity names injected as a ~150-token prefetch tell the model what the vault knows about this topic. On open-ended queries ("yo", "what's on my mind"), this is enough — the model calls PassThrough and responds directly from the vault overview (total: ~5K tokens, 1.9s)
2. **Familiarity indicator** — high-relevance catalysts mean the user has been thinking about this; no matches mean it's new territory. The model calibrates accordingly
3. **Search targeting** — when the model does search, the entity names from the prefetch guide what it searches for. Each VaultSearch call returns 2,000-3,000 tokens of content excerpts — substantial context, but targeted rather than exploratory

## Architecture

### The agent loop

```
prompt(text)
  → clear old tool results (stabilize KV cache prefix)
  → prefetch: enzyme catalyze on recent messages
  → inject catalyst questions + entity names as context
  → model: decide tools or pass through
  → if tools: execute in parallel, then synthesize response
  → if pass through: respond directly from vault overview
  → warm KV cache for next prompt
```

Two turns max. No while-loop iteration. The model handles both structured decisions (tool calls) and prose synthesis.

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

For local models (llama.cpp, LM Studio), the append-only message strategy during the tool-call loop ensures the inference server's KV cache stays valid — verified via debug logging with prefix stability checks.

### KV cache warming

Three points where the cache is warmed:
1. **Startup**: system prompt sent to the model before the user types
2. **During tool turn**: main model warms its prefix in parallel while tools execute
3. **After response**: stubbed prefix sent so the next prompt gets a cache hit immediately

On local inference (LM Studio), this reduced total latency from 2:25 to 1:34 for a typical search query.

## Tools

| Tool | Purpose | When |
|------|---------|------|
| `VaultSearch` | Semantic search via `enzyme catalyze` | Model finds specific content by concept |
| `TextSearch` | Grep for `#tags` and `[[wikilinks]]` | User references vault entities explicitly |
| `ReadFile` | Read full note by path | Need more than excerpts |
| `WriteFile` | Write/create a note | Drafting |
| `PassThrough` | Signal: no search needed | Open-ended or conversational prompts |

TextSearch is strictly for structural vault entities — tags and wikilinks that exist verbatim in markdown. It never searches for phrases or concepts. That distinction is enforced in the tool description (one sentence: "Find notes by #tag or [[wikilink]]. Omit # for tags. Never use for phrases or concepts.") and validated through prompt tuning against Haiku-class models.

## Running it

```bash
# Set up once in your shell profile
export OPENAI_API_KEY=sk-or-...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_MODEL=qwen/qwen3-32b

# Then just run in your vault
cd ~/vault && npx @jshph/digest

# Or pass a path
npx @jshph/digest ~/vault

# Local (LM Studio)
npx @jshph/digest --base-url http://localhost:1234/v1 --model qwen/qwen3.5-9b

# Debug logging
DEBUG=1 npx @jshph/digest
```

Any OpenAI-compatible endpoint works — OpenRouter, LM Studio, Ollama, vLLM, etc. Set `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` as environment variables, or pass `--model` and `--base-url` on the command line. The vault path defaults to the current directory.

## Read the code

The codebase is designed to be read top-to-bottom as a reference for building minimal agents:

1. **[src/core/types.ts](src/core/types.ts)** — Every type in the system. Start here.
2. **[src/core/agent.ts](src/core/agent.ts)** — The agent loop: prefetch, tool routing, KV cache warming.
3. **[src/context/prefetch.ts](src/context/prefetch.ts)** — Automatic vault context retrieval via Enzyme catalyze.
4. **[src/tools/text-search.ts](src/tools/text-search.ts)** — Entity search (#tags, [[wikilinks]]) via grep.
5. **[src/tools/vault-search.ts](src/tools/vault-search.ts)** — Semantic search via Enzyme catalyze (tool version).
6. **[src/context/compact.ts](src/context/compact.ts)** — Conversation summarization for small context windows.
7. **[src/core/providers/openai.ts](src/core/providers/openai.ts)** — OpenAI-compatible provider with KV cache warming.
8. **[src/prompt/system.ts](src/prompt/system.ts)** — Cache-aware system prompt construction.
9. **[src/core/debug.ts](src/core/debug.ts)** — JSONL debug logging for prompt tuning.

## How it compares to Claude Code SDK

Claude Code's SDK spawns a subprocess, pipes JSONL over stdio, and gives you the full Claude Code agent — permissions, hooks, MCP tools, session persistence. It's powerful, but it's also 70K+ LOC, Anthropic-only, and inherits the explore-mode token economics: the agent decides to search, reads results, decides to search again, and burns 60-90K tokens per response.

Digest is a 2,700 LOC in-process agent loop. You call `agent.prompt()` directly. The `tool()` helper and Read/Write tools mirror the CC SDK's signatures, so porting is straightforward. But the architecture is fundamentally different — Enzyme's pre-computed index means the agent already has context before it starts thinking, so a complete response costs 5-8K tokens instead of 60-90K.

| | Claude Code SDK | Digest |
|---|---|---|
| Tokens per response | 60,000-90,000 (explore loop) | 5,000-8,000 (prefetch + 2 turns) |
| LLM round trips | 5-10 | 2 |
| Runtime | Subprocess (spawns CLI, stdio JSONL) | In-process (`agent.prompt()`) |
| Providers | Anthropic only | Any OpenAI-compatible endpoint |
| Size | ~70K LOC | ~2,700 LOC |

The tradeoff: you lose sessions, permissions, subagents, and the full built-in tool suite (Bash, Glob, Grep, etc.). You gain provider freedom, explicit context control, and 10x fewer tokens per response.

See **[MIGRATION.md](MIGRATION.md)** for the full mapping: tool definitions, streaming events, provider setup, and what you gain/lose.

## Appendix: Two-model router/synthesizer split

Digest supports an experimental two-model setup where a small, fast model handles tool routing and a larger model handles synthesis. The idea: a 3B model is plenty smart to decide "search or pass through?" and extract a query, while a 9B+ model writes the actual response.

```bash
# Two-model setup (experimental)
export OPENAI_API_KEY=sk-or-...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
npx @jshph/digest ~/vault --model qwen/qwen3.5-9b \
  --router-model mistralai/ministral-3b-2512
```

When `--router-model` is set, the agent loop changes:

| | Router (3B) | Synthesizer (9B) |
|---|---|---|
| Purpose | Decide: search or pass through | Write the response |
| Tools | Search, PassThrough | None |
| Output | Tool-call JSON only | Prose only |
| Speed | ~400ms (pass through), ~2s (tools) | ~5s |

The synthesizer never sees tool definitions on the response turn. This prevents it from re-searching instead of answering — a common failure mode when small models have tools available.

**Why this should work well in theory**: the routing decision is a classification task (search vs. no search) that doesn't need a large model. Separating it means the main model's context window is never polluted with tool definitions on the synthesis turn, and you can run both models in parallel on Apple Silicon (router on efficiency cores while main model warms its KV cache). In practice, a single capable model (32B+) handles both roles well enough that the complexity of two models may not be worth it for most users.

Real numbers from a follow-up query (OpenRouter, Qwen 9B + Ministral 3B):
- 3 parallel VaultSearch calls: 2,442 + 2,918 + 1,962 tokens of results
- Router decision: 830ms, 71 output tokens
- Synthesis: 7.3s to first token, ~600 tokens of response
- Total: ~8K tokens consumed, 2 turns
