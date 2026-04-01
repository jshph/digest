# Prompt Cache Architecture

## The Problem

On a 5-turn conversation, without caching every turn re-processes the entire system prompt + tools + petri overview. At 8K context that's ~1,500 tokens of system overhead re-tokenized each turn — wasteful and slow, especially on smaller models.

## How Anthropic Prompt Caching Works

The API caches input tokens at `cache_control` breakpoints. Everything from the start of the request up to and including a block with `cache_control: { type: 'ephemeral' }` becomes the cached prefix. On subsequent requests with the same prefix, those tokens are read from KV cache (~90% cheaper, near-zero processing time).

Key constraints:
- Cache breakpoints go on `system` content blocks or `messages`
- Minimum cacheable prefix: **2,048 tokens** (Haiku 4.5) / **1,024 tokens** (Sonnet, Opus)
- `ephemeral` cache lives for 5 minutes of inactivity
- Tool definitions are hashed WITH the system prompt — same tools = same cache key

## Scribe's Cache Strategy

```
REQUEST STRUCTURE (each turn):

┌─────────────────────────────────────────────────────┐
│ system[0]: identity + tool guidance + context rules  │ ← CACHED (single block)
│            + enzyme petri overview                    │   + cache_control breakpoint
├─────────────────────────────────────────────────────┤
│ system[1]: memory + date/env                         │   uncached (may change)
├─────────────────────────────────────────────────────┤
│ tools: [TextSearch, ReadFile, WriteFile]              │ ← part of cache key hash
├─────────────────────────────────────────────────────┤
│ messages: [prefetch context, user, assistant,         │   uncached (changes every turn)
│            tool_result, ...]                          │
└─────────────────────────────────────────────────────┘
```

### Design Decision: Single Cached Block

All stable content (identity, tool guidance, context guidance, petri overview) is merged into a **single cached block**. Earlier versions split these across 2 blocks, but merging maximizes the chance of hitting the cache minimum threshold.

### Why Catalyze Results Are NOT Cached

Enzyme catalyze results (from the prefetch) are injected as user messages — they change every turn based on the conversation topic. The petri *overview* is cached (it's the vault map, constant for the session), but catalyze *search results* vary and belong in messages.

## Real-World Cache Findings

### Haiku 4.5: Cache Does NOT Activate

Tested with debug logging (`SCRIBE_DEBUG=1`). Results across 9 LLM calls:

```
cache_write: 0 on every turn
cache_read: 0 on every turn
```

**Root cause**: Haiku 4.5 requires **2,048 tokens minimum** for cache activation. Our cached system block is ~661 tokens. Even with tool definitions (~600 tokens) in the cache key hash, the minimum threshold applies to the **system text content alone**, not system + tools.

### Options Considered

| Option | Tokens | Trade-off |
|--------|--------|-----------|
| Accept it | 661 | Re-processing 661 tokens per turn is cheap (~$0.00003) |
| Pad system prompt to 2,048 | 2,048 | Wastes ~1,400 tokens on filler — defeats the purpose |
| Expand petri output | variable | Useful padding if the extra context helps |
| Use Sonnet (1,024 minimum) | 661 | Still under threshold, but closer |

**Decision**: Accept it. For an 8K context window, 661 tokens of re-processing per turn is negligible. The architectural support for caching is in place — it activates automatically when the cached block exceeds the model's threshold (e.g., with a larger vault petri, or on a future model with lower minimums).

### When Caching Will Activate

The cache architecture activates when:
1. The vault has enough entities that petri output pushes the cached block past 2,048 tokens
2. Using a model with a lower threshold (Sonnet at 1,024 is plausible)
3. Adding memory content to the cached block (if memory is stable across turns)

The REPL prints `system prompt: ~N tokens (M cached)` at startup. If `M` is under the model's threshold, caching won't activate. Debug logging shows `cache_read` and `cache_write` per turn.

## Implementation

The `SystemPromptBlock` type carries a `cache: boolean` flag:

```typescript
interface SystemPromptBlock {
  text: string
  cache: boolean  // true = part of cached prefix
}
```

The Anthropic provider finds the last block with `cache: true` and places `cache_control: { type: 'ephemeral' }` on it:

```typescript
function buildSystemBlocks(blocks: SystemPromptBlock[]): TextBlockParam[] {
  let lastCachedIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].cache) { lastCachedIndex = i; break }
  }
  return blocks.map((block, i) => ({
    type: 'text',
    text: block.text,
    ...(i === lastCachedIndex && { cache_control: { type: 'ephemeral' } }),
  }))
}
```

## For Local Models

Local models (llama.cpp, vLLM, etc.) don't support Anthropic's cache_control API. But:

1. The block structure still works — blocks are just concatenated
2. Some local servers have their own KV cache persistence (vLLM prefix caching)
3. The cache flag is informational — the provider can ignore it gracefully
4. The real win for local models is the small total prompt size (~1,500 tokens vs Claude Code's ~11,000+)

## Comparison with Claude Code

Claude Code uses `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` to split cached/uncached:
- Static prefix: ~2,250 tokens (identity, rules, tasks, actions, tools, tone)
- Dynamic suffix: ~4,000-8,000 tokens (session guidance, memory, env, MCP, etc.)
- Tool definitions: ~6,000-8,000 tokens

Scribe:
- Cached block: ~661 tokens (identity + petri + tool guidance + context guidance)
- Dynamic suffix: ~10-200 tokens (memory + date)
- Tool definitions: ~600 tokens (3 tools)

Claude Code's prefix easily exceeds the 2,048 minimum. Scribe's doesn't — but Scribe's total overhead is 7x smaller, which matters more on an 8K context window than caching does.
