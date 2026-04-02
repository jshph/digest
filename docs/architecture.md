# Architecture

## The agent loop

Each `agent.prompt()` call runs a unified tool loop:

```
prompt(text)
  → clear old tool results (stabilize prefix)
  → prefetch: enzyme catalyze on recent messages (~150 tokens)
  → enter loop:
      → call model with tools (text suppressed)
      → no tool calls? re-emit text → done
      → tool calls? execute → inject synthesis directive → loop
  → max 1 tool round, then forced text response
  → warm KV cache for next prompt
```

### Why all turns include tools

On llama.cpp with Qwen, the Jinja chat template bakes tool definitions into the system prompt as `<tools>` XML. Removing tools between turns changes the system prompt tokens, breaking the KV cache prefix. By including tools on every turn, the prefix stays identical → cache hits.

### The ephemeral synthesis directive

After tool execution, a user message is injected before the next model call:

```
"Respond using the search results already in the conversation.
Already searched: "craft AI tension", "entrepreneurship".
Do NOT call VaultSearch unless the user is asking about a topic
with NO relevant results above."
```

This lists prior VaultSearch queries so the model can see what's already covered. The message is **removed after the model responds** so it doesn't pollute the prefix for future turns.

### Synthesize-first prompting

The system prompt defaults the model to synthesizing from existing context rather than searching. VaultSearch is marked as "expensive" and reserved for genuinely new topics. On followup turns ("tell me more", "how does X connect"), the model typically responds from prior results.

`maxToolRounds=1` caps tool usage: one search opportunity per prompt, then forced synthesis. This prevents the model from spiraling into repeated searches with slightly different queries.

## Context management

### Tool result clearing

Old tool results are replaced with one-line stubs (`[VaultSearch result cleared — ...]`) to free tokens. The `keepRecentToolResults` config (default: 2) controls how many full results are preserved.

Clearing happens once at the start of `prompt()`, not during the tool loop — this keeps the prefix stable for KV cache hits within a single prompt.

### Compaction

When estimated token usage exceeds `compactThreshold` (default: 70% of `maxTokens`), older messages are summarized into a single `SystemCompactMessage`. The model sees `[Previous conversation summary]` and continues.

## KV cache warming

Cache is warmed at two points:

1. **Startup**: system prompt + tools sent before the user types
2. **After response**: stubbed prefix sent as a fire-and-forget `max_tokens=1` request

The warmup ensures the next user prompt's prefix is already in the server's KV cache, reducing time-to-first-token.

### Warmup quirk for Qwen

Qwen's Jinja template requires the last message to be a user message. The warmup appends a dummy `{ role: 'user', content: '.' }` when the conversation ends with an assistant message to avoid template errors.

## Cache-aware prompt structure

```
CACHED (stable across all turns):
  [single block] identity + tool guidance + context rules + enzyme petri overview

UNCACHED (may change per turn):
  memory (MEMORY.md, capped at 200 lines)
  date/env
```

The cached block merges all stable content into one block to maximize the chance of exceeding the minimum cache threshold on Anthropic's API (1,024-2,048 tokens depending on model).

## Token budget

| Component | Tokens |
|-----------|--------|
| System prompt (with 20-entity petri) | ~2,500 |
| Tool definitions (VaultSearch, ReadFile, WriteFile) | ~400 |
| **Base overhead** | **~2,900** |
| VaultSearch result (typical) | 5,000-15,000 |
| Conversation per turn | 500-1,500 |
