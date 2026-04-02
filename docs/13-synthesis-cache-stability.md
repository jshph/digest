# 13 — Synthesis Turn Cache Stability

Follows from [12-router-synthesizer-architecture.md](12-router-synthesizer-architecture.md). That doc established the two-turn flow (tool call → synthesis). This one covers the KV cache problems we found on the synthesis turn and the tradeoffs in fixing them.

## The Problem

In the main-as-router setup (no separate router model), each user prompt produces two LLM calls:

1. **Tool-calling turn**: system prompt + tools + messages → model calls TextSearch/VaultSearch
2. **Synthesis turn**: system prompt + messages + tool results → model responds in prose

These two calls had **different prefixes**:
- Call 1 included tool definitions in the request
- Call 2 did not (tools were omitted to prevent re-calling)

On backends with prefix-based KV caching (llama.cpp, vLLM), the cache from call 1 was useless for call 2 — the token sequences diverged right after the system prompt. The synthesis turn paid full prefill cost every time.

Verified in llama.cpp server logs:
```
task 422 (tools):     restored checkpoint at 2684, processed 271 new tokens  <- cache hit
task 563 (synthesis): n_past = 3, erased all checkpoints, full reprocess     <- total miss
```

### Additional issues found

1. **Synthetic user message pollution**: A `"You have enough context now..."` directive was injected before synthesis and left permanently in the conversation. On subsequent turns this shifted the prefix, breaking cache for future prompts.

2. **Warmup errors on Qwen**: The fire-and-forget KV warmup sent conversations ending with an assistant message. Qwen's Jinja template requires the last message to be a user message, causing 500 errors (`No user query found`) and 400 errors (`Assistant response prefill is incompatible with enable_thinking`).

3. **Aggressive search prompting**: System prompt said "search on ANY topic reference, even vaguely" — small models (9B) would re-search identical queries on follow-up turns even when results were still in context.

## The Fix

### Tool definitions always included

Both the tool-calling turn and the synthesis turn now send the same tool definitions. This keeps the prefix (system prompt + tools) identical between calls, enabling KV cache reuse on the synthesis turn.

To prevent the model from actually calling tools on synthesis, we send `tool_choice: "none"`.

### Fallback for backends that ignore tool_choice

Qwen's Jinja chat template bakes tool instructions into the prompt via XML (`<tools>...</tools>`) and the model emits `<tool_call>` XML natively. The `tool_choice` parameter has no effect — it's not part of the template's logic.

When the synthesis response contains only tool calls and no text, the agent discards it and retries with `main-no-tools` (no tool definitions at all). This retry pays full prefill cost but produces a usable response.

### Warmup fix

Warmup requests now append a dummy `{ role: 'user', content: '.' }` when the conversation ends with an assistant message, satisfying Qwen's template requirement.

### Softer search prompting

Changed from "search on ANY topic reference, even vaguely" to "search for topics not already covered by results in the conversation." Added "You get ONE round of tool calls" to set expectations for single-turn tool use.

## Tradeoffs

### By backend

| Backend | Synthesis behavior | Cache | Cost |
|---|---|---|---|
| **OpenAI / OpenRouter** | `tool_choice: "none"` works | Cache hit on synthesis | 1 call, optimal |
| **vLLM** | `tool_choice: "none"` works | Cache hit on synthesis | 1 call, optimal |
| **llama.cpp (Qwen)** | `tool_choice` ignored, retry fires | Cache hit on first attempt (discarded), miss on retry | 2 calls — ~5s overhead |
| **llama.cpp (non-Qwen)** | Depends on Jinja template | Varies | 1-2 calls |

### The llama.cpp tax

On llama.cpp with Qwen, the agent pays for:
1. A wasted synthesis call (cache-hit prefill is cheap, but ~60 output tokens are discarded)
2. A retry without tools (full prefill, cache miss)

This is worse than just calling without tools directly (1 call, cache miss). The retry pattern optimizes for cloud APIs where `tool_choice: "none"` works, at the cost of an extra wasted call on llama.cpp.

A future optimization: add `supportsToolChoice?: boolean` to the provider interface and skip the first attempt when false. Not implemented — the overhead is small and the pattern works universally without per-backend configuration.

### System prompt stability

The XML suppression suffix (`"Do not emit tool calls..."`) is only appended when no tools are sent (the `main-no-tools` fallback path). When tools are present, the system prompt is never mutated — this preserves prefix stability for KV cache reuse across turns.

### What we removed

- The synthetic `"You have enough context now..."` user message — it was injected before synthesis and left in the conversation permanently, polluting the prefix for all future turns. Removed entirely. The synthesis turn now relies on `tool_choice: "none"` (or no tools on retry) instead of a prompt directive.

## Qwen Jinja template notes

The Qwen3 chat template (extracted from `Qwen/Qwen3-8B` tokenizer) has specific behaviors that affect agent design:

1. **Tool results become user messages**: `role: "tool"` messages are wrapped in `<tool_response>` tags inside a `<|im_start|>user` block
2. **`multi_step_tool` detection**: The template walks backwards through messages looking for a real user message (not a `<tool_response>`). If none found, it raises an exception
3. **`<tool_call>` is native format**: The template instructs the model to emit `<tool_call>` XML — this is not hallucination, it's the designed format
4. **`tool_choice` is invisible**: The parameter is not part of the Jinja template logic. The template always renders tool instructions when `tools` is non-empty
5. **`enable_thinking` blocks assistant prefill**: Cannot send a conversation ending with an assistant message when thinking is enabled

## Conversation shape

After these changes, the conversation after a tool-call prompt looks like:

```
[0] user: "hey whats up"
[1] assistant: greeting
[2] user: [prefetch context]
[3] user: "explore entrepreneurship"
[4] assistant: { tool_calls: [TextSearch] }
[5] tool_result: TextSearch (582 tokens)
[6] assistant: synthesis response          <- no synthetic user message between 5 and 6
```

No injected directives between tool results and synthesis. Clean prefix for future turns.
