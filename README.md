<div align="center">

# ⚡ Digest

**A 2,700-line agent that talks to your Obsidian vault.**<br>
**Runs on local 9B models. 8ms semantic lookup via [Enzyme](https://www.enzyme.garden/).**

[![npm](https://img.shields.io/npm/v/@jshph/digest?color=cb3837&logo=npm)](https://www.npmjs.com/package/@jshph/digest)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

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

Digest with Enzyme (~5-20K tokens, 1-2 turns):
  enzyme catalyze (8ms) → routing signal (~150 tokens)
  → model decides: search or respond from context
  → if search: VaultSearch → synthesize from results
  → if no search: respond directly from vault overview + prior results
```

The catalysts serve a dual purpose beyond retrieval:

1. **Routing signal** — catalyst questions and entity names injected as a ~150-token prefetch tell the model what the vault knows about this topic. On open-ended queries ("yo", "what's on my mind"), this is enough — the model responds directly from the vault overview
2. **Familiarity indicator** — high-relevance catalysts mean the user has been thinking about this; no matches mean it's new territory. The model calibrates accordingly
3. **Search targeting** — when the model does search, the entity names from the prefetch guide what it searches for

## Architecture

```
prompt(text)
  → prefetch: enzyme catalyze (8ms, ~150 tokens of context)
  → model decides: search or respond from existing context
  → if search: VaultSearch → synthesize from results
  → if no search: respond directly
  → warm KV cache for next prompt
```

The model defaults to **synthesizing from existing context** — prior search results, vault overview, conversation history. It only calls VaultSearch when the user introduces a genuinely new topic. On followup turns ("tell me more", "how does X connect"), it works with what's already there. This keeps multi-turn conversations fast: a greeting is ~5s, a deep search is ~40s, and followups that don't need new context are ~10s.

| Component | Explore-mode agent | Digest |
|-----------|-------------------|--------|
| System prompt | 15,000-20,000 tokens | ~2,500 tokens |
| Search results per response | 10,000-30,000 (multiple rounds) | 5,000-15,000 (1 targeted search) |
| **Total per response** | **60,000-90,000** | **5,000-20,000** |
| **Minimum context window** | **32K-128K** | **8K** (open-ended) / **32K** (deep search) |

For implementation details, see:
- **[docs/architecture.md](docs/architecture.md)** — agent loop, caching, synthesis directives, token budget
- **[docs/qwen-llama-cpp.md](docs/qwen-llama-cpp.md)** — Qwen Jinja template gotchas, XML handling, 9B model limitations
- **[docs/modal-gpu-testing.md](docs/modal-gpu-testing.md)** — GPU test harness for faster iteration

## Tools

| Tool | Purpose | When |
|------|---------|------|
| `VaultSearch` | Semantic search via `enzyme catalyze` | Model needs content on a new topic |
| `ReadFile` | Read full note by path | User wants to go deeper into a specific note |
| `WriteFile` | Write/create a note | Drafting |

VaultSearch is the primary retrieval tool — expensive (returns 5-15K tokens of excerpts) but comprehensive. The system prompt tells the model to prefer synthesizing from existing results and only search for genuinely new topics. On followup turns ("tell me more", "how does X connect to Y"), the model typically responds from context rather than re-searching.

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
2. **[src/core/agent.ts](src/core/agent.ts)** — The agent loop: prefetch, unified tool loop, KV cache warming.
3. **[src/context/prefetch.ts](src/context/prefetch.ts)** — Automatic vault context retrieval via Enzyme catalyze.
4. **[src/tools/vault-search.ts](src/tools/vault-search.ts)** — Semantic search via Enzyme catalyze.
5. **[src/context/compact.ts](src/context/compact.ts)** — Conversation summarization for small context windows.
6. **[src/core/providers/openai.ts](src/core/providers/openai.ts)** — OpenAI-compatible provider with KV cache warming and Qwen XML stripping.
7. **[src/prompt/system.ts](src/prompt/system.ts)** — Cache-aware system prompt construction.
8. **[src/core/debug.ts](src/core/debug.ts)** — JSONL debug logging for prompt tuning.

## How it compares to Claude Code SDK

Claude Code's SDK spawns a subprocess, pipes JSONL over stdio, and gives you the full Claude Code agent — permissions, hooks, MCP tools, session persistence. It's powerful, but it's also 70K+ LOC, Anthropic-only, and inherits the explore-mode token economics: the agent decides to search, reads results, decides to search again, and burns 60-90K tokens per response.

Digest is a 2,700 LOC in-process agent loop. You call `agent.prompt()` directly. But the architecture is fundamentally different — Enzyme's pre-computed index means the agent already has context before it starts thinking.

| | Claude Code SDK | Digest |
|---|---|---|
| Tokens per response | 60,000-90,000 (explore loop) | 5,000-20,000 (prefetch + 1-2 turns) |
| LLM round trips | 5-10 | 1-2 |
| Runtime | Subprocess (spawns CLI, stdio JSONL) | In-process (`agent.prompt()`) |
| Providers | Anthropic only | Any OpenAI-compatible endpoint |
| Size | ~70K LOC | ~2,700 LOC |

The tradeoff: you lose sessions, permissions, subagents, and the full built-in tool suite (Bash, Glob, Grep, etc.). You gain provider freedom, explicit context control, and 10x fewer tokens per response.

See **[MIGRATION.md](MIGRATION.md)** for the full mapping: tool definitions, streaming events, provider setup, and what you gain/lose.

## GPU testing with Modal

For faster iteration on prompt tuning and agent behavior, Digest includes a Modal deployment that runs the same llama-server on a cloud GPU. This mirrors the local Mac setup with 3-5x faster inference.

```bash
# Setup (one-time)
python3 -m venv .venv && source .venv/bin/activate
pip install modal && modal profile activate <your-profile>

# Dev mode (streams logs, hot-reloads)
modal serve modal_llama.py

# Multi-turn test against Modal
printf 'hey\nexplore craft vs AI\nsay more about that\n' | \
  OPENAI_BASE_URL=<modal-url> OPENAI_MODEL=qwen/qwen3.5-9b npx @jshph/digest
```

Uses the pre-built `ghcr.io/ggml-org/llama.cpp:server-cuda` image — native C++ llama-server with CUDA, zero compilation. Model is baked into the image (~2 min first build, then cached).

| Metric | M5 (local) | L4 (Modal) | Speedup |
|--------|-----------|-----------|---------|
| Prefill | 350-420 tok/s | 2,100 tok/s | 5x |
| Generation | 16-19 tok/s | 36 tok/s | 2x |
| 4-turn session | ~220s | ~70s | 3x |

See **[docs/modal-gpu-testing.md](docs/modal-gpu-testing.md)** for full setup details.
