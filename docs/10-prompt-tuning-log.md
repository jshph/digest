# Prompt Tuning Log

What we learned from running Scribe against a real Obsidian vault with debug logging.

## Setup

- Model: `claude-haiku-4-5-20251001`
- Context: 8,192 tokens
- Vault: Obsidian vault with 5 entities indexed by Enzyme
- System prompt: ~670 tokens (661 cached)
- Tools: 3 (TextSearch, ReadFile, WriteFile)
- Debug: JSONL log capturing prefetch, system prompt, LLM requests/responses, tool calls

## Test Results

Three query patterns tested, each exercising a different path:

### Test 1: Conceptual query (no anchors)

**Input**: "What tensions am I holding between building and belonging?"

| Metric | Value |
|--------|-------|
| Turns | 1 |
| Total input tokens | 1,915 |
| Total output tokens | 379 |
| Tool calls | 0 |
| Prefetch | Found, 2,384 chars |

The prefetch (enzyme catalyze) found relevant content and the model responded directly from it. No tools needed. This is the ideal path for thematic questions.

### Test 2: Tag query (#entity)

**Input**: "What do I have tagged #enzyme/pmf?"

| Metric | Value |
|--------|-------|
| Turns | 3 |
| Total input tokens | 7,719 |
| Total output tokens | 484 |
| Tool calls | TextSearch("enzyme/pmf") ×2 |
| Prefetch | Found, 2,233 chars |

The model correctly used TextSearch for the #tag entity. Called it twice expecting different results (duplicate call — a small model behavior we accept for now).

### Test 3: Wikilink query ([[entity]])

**Input**: "What's in [[open questions]]?"

| Metric | Value |
|--------|-------|
| Turns | 3 |
| Total input tokens | 7,600 → 8,990 (after fixes) |
| Total output tokens | 524 → 686 (after fixes) |
| Tool calls | TextSearch + ReadFile (correct paths after fixes) |
| Prefetch | Found, 2,311 chars |

After prompt tuning (see below), the model correctly searched for the entity via TextSearch, got file paths from results, then used ReadFile with those paths.

## Issues Found and Fixed

### 1. ReadFile called with concepts instead of file paths

**Problem**: Model called `ReadFile("founding")` and `ReadFile("open questions")` — treating entities as file paths, getting ENOENT errors.

**Root cause**: ReadFile description said "Read a vault file" without specifying that paths must come from search results.

**Fix**: Changed ReadFile description to: "Read a vault file by path. Path MUST come from a TextSearch result (e.g. 'inbox/2025-01-15.md'). Never guess paths." Also updated parameter description to show example paths.

### 2. Prefetch sending vault syntax to catalyze

**Problem**: User messages like "What do I have tagged #enzyme/pmf?" were passed raw to `enzyme catalyze`. The #hashtag syntax confused the semantic search — catalyze searches by concept, not by vault markup.

**Root cause**: Prefetch function passed raw user message as the catalyze query.

**Fix**: Strip vault syntax before querying:
```typescript
const query = raw
  .replace(/\[\[([^\]]+)\]\]/g, '$1')  // [[link]] → link
  .replace(/#([\w/.-]+)/g, '$1')        // #tag → tag
```

### 3. Cache not activating (0% hit rate)

**Problem**: `cache_read_input_tokens` was 0 on every turn, including turn 2+.

**Root cause**: Haiku 4.5 requires **2,048 tokens minimum** for cache activation. Our cached system block was only ~661 tokens. Even though we merged identity + petri into a single cached block, the text was still under the threshold.

**Diagnosis**: Tool definitions are part of the cache key hash but the `cache_control` breakpoint only applies to system text blocks. The minimum threshold applies to the system text content, not system + tools combined.

**Status**: Documented as a known limitation. On Haiku 4.5, caching doesn't activate with our prompt size. Options:
1. Accept it — the absolute token count is small (661 tokens), so re-processing is cheap
2. Pad the system prompt to reach 2,048 (adds ~1,400 tokens of unused content — defeats the purpose)
3. Use a model with a lower threshold (Sonnet: 1,024 tokens)
4. Expand the petri overview to provide more context (useful padding)

For the 8K-targeting-local-models use case, caching is less important than keeping the prompt small.

### 4. Duplicate TextSearch calls

**Problem**: Model called `TextSearch("enzyme/pmf")` twice in the same session expecting different results.

**Root cause**: Small model behavior — Haiku doesn't always recognize that a second identical tool call will return the same results.

**Status**: Accepted for now. Could add deduplication in the agent loop (reject tool calls with identical name+args within the same prompt() invocation).

## Tool Description Evolution

Tool descriptions were progressively tightened for small model comprehension:

### TextSearch
- **v1**: "Search vault files for exact text. Use for names, #tags, [[wikilinks]], titles, and proper nouns — anything that appears verbatim in notes."
- **v2**: "Find notes containing a vault entity — a #tag or [[wikilink]]. Only use this for structural entities that appear in vault markup."
- **v3 (current)**: "Find notes by #tag or [[wikilink]]. Omit # for tags. Never use for phrases or concepts."

### ReadFile
- **v1**: "Read the full content of a file from the vault."
- **v2**: "Read a vault file. Use when excerpts from pre-fetched context are not enough."
- **v3 (current)**: "Read a vault file by path. Path MUST come from a TextSearch result (e.g. 'inbox/2025-01-15.md'). Never guess paths."

### WriteFile
- **v1**: "Write content to a file in the vault. Creates parent directories if needed."
- **v2 (current)**: "Write or create a file in the vault."

**Pattern**: Small models need shorter, more directive descriptions with explicit DO/DON'T rules and example values. Long explanatory descriptions get ignored or misinterpreted.

## System Prompt Evolution

### Tool guidance section
- **v1** (VaultSearch as tool): "Use VaultSearch for conceptual queries. Use TextSearch for exact matches: names, #tags, [[wikilinks]]."
- **v2** (prefetch pattern): "Relevant vault content is automatically retrieved each turn. When the user references #tags or [[wikilinks]], use TextSearch."
- **v3** (current): Also added "ReadFile takes a file path from TextSearch results. Never guess paths."

Key insight: The prefetch pattern eliminated the need to explain when to search vs. not search. The model just gets context and reasons about it. The remaining tool guidance is about TextSearch (entity-only) and ReadFile (paths-from-results-only).

## Debug Logging

Enable with `SCRIBE_DEBUG=1`. Writes JSONL to `debug.jsonl` (override with `SCRIBE_DEBUG_FILE`).

Log types and what they reveal:

| Type | What to look for |
|------|-----------------|
| `prefetch` | Is the query clean (no #/[[ syntax)? Content chars vs. relevance? |
| `system_prompt` | Block count, cached chars, estimated tokens. Is prefix large enough for caching? |
| `llm_request` | Message count and sizes. Is the context growing too fast? |
| `llm_response` | Stop reason, cache hit rate, input/output tokens. |
| `tool_call` | What args were passed? Any errors? Is the model misusing tools? |
| `compact` | How much was saved? Summary quality? |

Parse with: `python3 -c "import json; [print(json.loads(l).get('type')) for l in open('debug.jsonl')]"`
