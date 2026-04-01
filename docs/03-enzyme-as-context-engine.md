# Enzyme as Context Engine

Source: `/Users/joshuapham/Hacks/enzyme-rust/` (22,074 lines of Rust)

## What Enzyme Does

Enzyme is a semantic indexing engine for Obsidian vaults. It pre-processes your markdown into a searchable knowledge base using:

1. **Entities**: Tags, wikilinks, and folders — natural semantic clusters from how you already organize
2. **Catalysts**: AI-generated questions anchored to entities — probes that surface latent connections
3. **Embeddings**: Vector representations of content, stored in SQLite

## CLI Commands

| Command | Purpose |
|---------|---------|
| `enzyme init` | Index a vault (creates `.enzyme/enzyme.db`) |
| `enzyme refresh` | Incremental re-index (only changed content) |
| `enzyme petri` | Overview: trending entities + catalysts (JSON) |
| `enzyme catalyze "query"` | Semantic search by concept (JSON) |
| `enzyme apply <dir>` | Project vault catalysts onto external content |
| `enzyme status` | Check vault freshness |

## Architecture (3 crates)

- **enzyme-core** (bulk of code): pipeline, embedding, search, catalog, DB, models
  - `pipeline/` — indexing pipeline (catalysts, embedding, similarity, staleness)
  - `search/` — BM25, HNSW vector search, context search
  - `db/` — SQLite repository (1,451 lines)
  - `embedding/` — embedding service abstraction
  - `llm/` — LLM content registers (explore, continuity, reference)
- **enzyme-cli**: Commands + display formatting
- **enzyme-api**: Axum web server for API access

## Output Format

`enzyme catalyze` returns JSON:
```json
{
  "results": [
    { "file_path": "...", "content": "...", "similarity": 0.85 }
  ],
  "top_contributing_catalysts": [
    { "id": "...", "text": "What kept pulling you forward?", "entity": "#travel", "relevance_score": 0.9 }
  ]
}
```

`enzyme petri` returns trending entities with their catalysts, activity metadata, and temporal signals.

## How Enzyme Should Be Used in the Writing Agent

### Pre-conversation Context Compilation

Before the agent starts, run:
```bash
enzyme petri | jq .  # Vault overview
```
This gives the agent a map of what's in the vault — what entities are active, what themes are trending. This replaces the need for the agent to search files itself.

### Query-Time Context Retrieval (as a Tool/Skill)

When the agent needs to find relevant content:
```bash
enzyme catalyze "the tension between efficiency and presence" -n 10
```
Returns conceptually relevant content — far better than grep for writing tasks.

### Content Registers

Enzyme has a register system for different presentation modes:
- **Explore**: Open-ended discovery, per-catalyst guidance
- **Continuity**: Maintain a thread of thought across sessions
- **Reference**: Direct fact/content retrieval

This maps perfectly to different agent modes: brainstorming vs. continuing a draft vs. fact-checking.

### Integration Architecture

```
                    ┌─────────────────┐
                    │  enzyme refresh  │ (pre-session, in hook)
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  enzyme petri   │ → system context injection
                    └────────┬────────┘
                             │
┌──────────┐        ┌────────▼────────┐
│  User    │───────▶│   Agent Loop    │
│  prompt  │        │  (pi-style)     │
└──────────┘        └────────┬────────┘
                             │ tool call
                    ┌────────▼────────┐
                    │enzyme catalyze  │ → context for current query
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  LLM response   │ (with vault context)
                    └─────────────────┘
```

### Key Insight: Enzyme Replaces File Search

Claude Code needs Glob, Grep, Read tools to find code. A writing agent with enzyme needs:
1. `enzyme petri` — "what's in my vault?" → injected into cached system prompt
2. `enzyme catalyze` — "find relevant content" → runs automatically via prefetch (NOT a tool)
3. `grep` — find notes by #tag or [[wikilink]] → TextSearch tool (entity-only)
4. `Read` — read a specific file (still needed for full content)
5. `Write` — write/edit markdown files

The evolution from the original design: catalyze moved from a tool (VaultSearch) to an automatic prefetch. This eliminates a round trip — the model sees relevant vault context before it even starts reasoning. The prefetch strips vault syntax (#tags, [[wikilinks]]) from the query because catalyze searches by concept, not markup.

That's **3 tools** instead of Claude Code's **20+**. Each tool saved is ~200-500 tokens of schema definition per turn.

### Pre-warming with `--quiet` Mode

`enzyme init --quiet` and `enzyme refresh --quiet` output compact JSON that includes full petri data. Run this in a session-start hook to:
1. Check freshness
2. Get vault overview
3. Inject into system context

All in one call, before the first user message.
