# Multi-Provider Architecture

Scribe supports Anthropic's API and any OpenAI-compatible endpoint (LM Studio, Ollama, custom servers). An optional two-model setup splits work between a fast router model and a larger synthesis model.

## Usage

```bash
# Anthropic (default)
scribe ~/vault

# Single local model
scribe ~/vault --provider lmstudio --model qwen/qwen3.5-9b \
  --base-url http://127.0.0.1:1234/v1 --max-context 32768

# Two-model: router + synthesizer
scribe ~/vault --provider lmstudio \
  --model qwen/qwen3.5-9b \
  --router-model ministral-3-3b-instruct-2512 \
  --base-url http://127.0.0.1:1234/v1 \
  --max-context 32768

# Ollama (auto base URL: localhost:11434)
scribe ~/vault --provider ollama --model llama3.1:8b
```

All flags have env var equivalents: `SCRIBE_PROVIDER`, `SCRIBE_MODEL`, `SCRIBE_BASE_URL`, `SCRIBE_MAX_CONTEXT`, `SCRIBE_ROUTER_MODEL`, `SCRIBE_ROUTER_BASE_URL`.

## Two-Model Architecture

When `--router-model` is set, tool-call turns use the smaller router model and the final synthesis turn uses the main model. This exploits the fact that tool-call turns only emit JSON (tool name + arguments) — a 3B model handles this well and processes prompts ~3x faster than a 9B.

### Request flow

```
User message arrives
  │
  ├─ Clear old tool results (stub into prefix for KV cache stability)
  ├─ Prefetch: enzyme catalyze → inject catalyst questions + entity names
  │
  ├─ Tool turn (ROUTER model, 3B):
  │   ├─ Fire-and-forget: warm SYNTHESIS model KV cache with current prefix
  │   ├─ Router decides which tools to call, writes query arguments
  │   ├─ VaultSearch + TextSearch execute in parallel
  │   └─ Results appended to conversation
  │
  └─ Synthesis turn (MAIN model, 9B):
      ├─ Prefix already warm in KV cache (system prompt + prefetch + user msg)
      ├─ Only processes new suffix: tool results + synthesis nudge
      └─ Generates response with vault quotes, through-lines, and offers to go deeper
```

### Why it works

The router model doesn't need to be eloquent — it just needs to:
1. Read catalyst questions and entity names from the prefetch
2. Decide which tools to call (VaultSearch for concepts, TextSearch for #tags/[[wikilinks]])
3. Emit valid JSON tool call arguments

A 3B model does this well. The synthesis model does the hard work: reading excerpts, finding connections, matching the user's voice.

## Recommended Local Models

| Role | Model | Size | Notes |
|------|-------|------|-------|
| Synthesizer | Qwen 3.5 9B | 9B | Rich responses, good instruction following |
| Router | Ministral 3B Instruct | 3B | Purpose-built for function calling, best at this scale |
| Router (alt) | Phi-4-mini-Instruct | 3.8B | Strong reasoning, good tool selection |
| Router (alt) | Llama 3.2 3B Instruct | 3B | Proven tool calling, efficient on Apple Silicon |
| Router (alt) | Qwen2.5-3B-Instruct | 3B | Same family as synthesizer |

Both models load simultaneously in LM Studio's Multi Model Session.

## KV Cache Optimization

Local backends (llama.cpp, MLX) reuse KV cache when the prompt prefix matches byte-for-byte across requests. Three mechanisms keep the prefix stable:

### 1. Prefix stability during tool-call loop

Tool result clearing (replacing old results with stubs) happens once at the start of each `prompt()` call — not per turn. Within a prompt's tool-call loop, messages are append-only, so the prefix grows monotonically and the cache hits on every turn.

**Before (broken):**
```
Turn 1: [system] [user] [assistant] [tool_result: full]     → cached
Turn 2: [system] [user] [assistant] [tool_result: STUBBED]  → cache MISS (prefix mutated)
```

**After (fixed):**
```
Turn 1: [system] [user] [assistant] [tool_result: full]     → cached
Turn 2: [system] [user] [assistant] [tool_result: full] ... → cache HIT (prefix unchanged)
```

### 2. Parallel warming for synthesis model

When using a router, the synthesis model receives a `max_tokens: 1` warmup request with the current prefix while the router is working. By the time the router returns tool results and the synthesis turn starts, the 9B model's KV cache already has the prefix loaded. It only processes the new suffix (tool results + synthesis nudge).

### 3. Inter-prompt warming

After the agent finishes responding, a warmup request fires with the stubbed conversation prefix. While the user thinks and types their next message, the backend processes and caches this prefix. The next `prompt()` call benefits from a warm cache on turn 1.

### Verification

Enable debug logging (`SCRIBE_DEBUG=1`) and check `prefix_check` entries in the JSONL log:

```json
{"type":"prefix_check","kvCacheHit":true,"prevLen":9921,"currLen":17120}
{"type":"prefix_check","kvCacheHit":true,"prevLen":17120,"currLen":30120}
```

All turns within a prompt should show `kvCacheHit: true`.

## Prefetch as Routing Signal

The prefetch runs `enzyme catalyze` on the user's message before the LLM sees it. It injects only:

- **Catalyst questions** — tensions and themes the vault surfaces around the topic
- **Entity names** — vault entities those catalysts belong to (e.g. "craft", "enzyme/pmf")

This is ~150 tokens, not the ~2K tokens of full file excerpts from the old approach. The model uses catalysts to write VaultSearch queries and entity names for TextSearch queries (`#craft`, `[[enzyme/pmf]]`). Both fire in parallel on the first tool turn.

### Why not inject full content?

1. **Token budget** — 2K tokens of prefetched content per turn eats into the context window
2. **Model behavior** — with full content injected, the model responds directly without searching, missing content that catalyze didn't surface
3. **Agency** — the model writes better queries than raw user text passed to catalyze, because it can bridge user intent with vault vocabulary from the petri overview

## Tool Result Sizing

| Tool | Size | Rationale |
|------|------|-----------|
| VaultSearch | Full excerpts (no cap) | ~500-2000 chars per result, 5 results. Rich enough to synthesize from directly |
| TextSearch | Grep matches | Small, exact matches for #tags and [[wikilinks]] |
| ReadFile | 1,500 char cap | Only used when user explicitly asks for more detail |

VaultSearch returning full excerpts is key to `maxToolTurns: 1` working — the model has enough content to synthesize without needing ReadFile follow-ups.

## Performance

Benchmarks on Apple Silicon (M-series), LM Studio, same query:

| Configuration | Wall time | Total input tokens | Output tokens |
|---------------|-----------|-------------------|---------------|
| Single Qwen 9B, 5 tool turns | 2:25 | ~28K | 848 |
| Single Qwen 9B, 3 tool turns | 3:55 | ~46K | 1,064 |
| Single Qwen 9B, 1 tool turn | 1:58 | ~10K | 804 |
| Ministral 3B router + Qwen 9B | 1:52 | ~9K | 881 |
| Router + KV pre-warm | 1:34 | ~9K | 725 |

The 3-turn run was slowest because the model made redundant ReadFile calls that inflated token count. Fewer turns with richer search results (full VaultSearch excerpts) produced similar quality at much lower latency.

## Cache Control

Anthropic's API supports `cache_control` breakpoints on system prompt blocks. The provider places `cache_control: { type: 'ephemeral' }` on the last cached block, creating a stable prefix for KV cache reuse across turns.

Local providers (LM Studio, Ollama) don't support this API-level cache control. The `cache` hints on `SystemPromptBlock` are ignored — blocks are concatenated into a single system message. KV cache reuse happens at the inference engine level (llama.cpp slot matching) based on prompt prefix similarity, which is why prefix stability matters.
