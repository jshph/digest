# Compaction Strategy for Small Context Windows

## Claude Code's Approach (for reference)

Context: 200K-1M tokens. Triggers compaction at `contextWindow - 13,000` tokens.

Their compaction prompt (~1,500 tokens) asks for a 9-section structured summary:
1. Primary request and intent
2. Key technical concepts
3. Files and code sections (with snippets)
4. Errors and fixes
5. Problem solving
6. All user messages (verbatim)
7. Pending tasks
8. Current work
9. Optional next step

Key techniques:
- **Analysis scratchpad**: `<analysis>` tags for drafting, stripped from final output
- **Partial compaction**: Summarize old messages, keep recent ones intact
- **Post-compaction framing**: "This session is being continued from a previous conversation"
- **Transcript reference**: Points to full transcript file for details
- **No-tools preamble**: Forces text-only response during compaction (prevents wasted tool calls)
- **MicroCompact**: Separately clears old tool results between full compactions

## Adapted Strategy for 8K-32K Context

### Trigger Points

| Context Size | Compact Trigger | Buffer | Available After Compact |
|-------------|----------------|--------|------------------------|
| 8K | 5,600 (70%) | 2,400 | ~5,400 |
| 16K | 11,200 (70%) | 4,800 | ~13,400 |
| 32K | 22,400 (70%) | 9,600 | ~29,400 |

Trigger at **70%** instead of Claude Code's ~93% — small context means less room for the compaction response itself.

### Compaction Prompt (Writing-Optimized, ~600 tokens)

```
Respond with TEXT ONLY. Do NOT call any tools.

Summarize this conversation for continuing the session. Focus on:

1. What the user is working on (the writing project, idea, or exploration)
2. Key ideas, themes, and connections discovered
3. Vault content referenced (file paths and key excerpts)
4. The user's voice and style preferences observed
5. Where things left off — what was being drafted or explored
6. Next direction (only if clear from context)

Keep the summary under 500 words. Preserve specific quotes, file paths, and
thematic language rather than generalizing. The goal is to pick up the thread
without the user having to re-explain.
```

### What Changes from Claude Code

| Claude Code | Scribe |
|------------|--------|
| 9-section template | 6-point focused summary |
| Code snippets, errors, function signatures | Ideas, themes, voice, connections |
| All user messages verbatim | Key user messages summarized |
| ~2,000 token summary budget | ~500 word / ~700 token summary budget |
| Partial compaction (keep recent) | Same — keep last 2 exchanges |
| MicroCompact (tool result clearing) | Simpler: clear results older than 2 turns |

### Tool Result Clearing (Between Compactions)

Claude Code's approach: A separate "microcompact" system that clears old tool results, keeping N most recent.

Simpler approach for Scribe:
- After each turn, check if any tool results are older than 2 turns
- Replace old tool results with a one-line stub: `[VaultSearch results for "query" — 5 results returned. Key files: a.md, b.md, c.md]`
- This preserves the *intent* (what was searched) and *key findings* without the full content

### Enzyme-Aware Compaction

Special handling for vault context:
- When compacting, preserve the `enzyme petri` summary (it's the vault map)
- Vault search results can be aggressively summarized — the content lives in the vault, not the conversation
- File read results: Keep only the passages that were directly discussed or quoted

### Pre-Compaction Prompt Injection

Before compaction, inject a system message:
```
Before this conversation is summarized, note any specific ideas, passages, or
connections that were important to the discussion. These details may not survive
the summary.
```

This is inspired by Claude Code's `SUMMARIZE_TOOL_RESULTS_SECTION` — prompting the model to save critical info before it's cleared.

### Partial Compaction Flow

```
Messages: [S1, U1, A1, U2, A2, U3, A3, U4, A4, U5, A5]
                                          ^^^^^^^^^^^^^^^^
                                          keep these intact

Compact messages [S1...A3] → summary

Result: [Summary, U4, A4, U5, A5]
```

For an 8K context, keeping 2 exchanges means ~1,500-2,000 tokens preserved, plus ~700 token summary, plus ~2,600 base overhead = ~5,300 tokens used, ~2,700 available for the next response.

### Emergency Compaction

If after compaction we're still over 85%, do an aggressive recompaction:
- Reduce summary to 200 words
- Clear ALL old tool results (not just >2 turns)
- Drop the enzyme petri overview

Claude Code has a similar circuit breaker (`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`).
