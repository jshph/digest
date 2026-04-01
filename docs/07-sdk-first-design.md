# SDK-First Design: Harness, Not CLI

## The Insight

Claude Code is a CLI that happens to have an SDK buried inside. The better approach: build an SDK that can be wrapped by any interface.

Pi already does this well — the `agent` package (1,859 lines) is purely a runtime. The `coding-agent` package wraps it with CLI/TUI concerns. The `web-ui` package wraps it differently for the browser.

## What "SDK-First" Means for a Writing Agent

### Core SDK (the harness)
```typescript
import { createAgent } from '@scribe/core'

const agent = createAgent({
  systemPrompt: '...',
  tools: [vaultSearch, vaultOverview, readFile, writeFile],
  model: { provider: 'local', endpoint: 'http://localhost:8080' },
  context: {
    maxTokens: 8192,
    compactAt: 0.7,  // 70% threshold
    compactPrompt: '...',
  },
  enzyme: {
    vaultPath: '/path/to/vault',
    preWarm: true,  // run enzyme refresh + petri at startup
  },
})

// Event-driven — any UI can subscribe
agent.on('message', (msg) => console.log(msg))
agent.on('tool_call', (call) => console.log(call))
agent.on('compact', (summary) => console.log('Compacted:', summary))

// Send a message
await agent.prompt('What have I been writing about travel lately?')
```

### Integration Points (not built-in, just supported)

1. **Claude Code Skill**: Scribe as a skill that Claude Code invokes
   ```yaml
   ---
   name: scribe
   description: Writing and thinking assistant with vault context
   allowed-tools: Bash, Read, Write
   ---
   ```

2. **MCP Server**: Expose vault context as MCP resources
   ```typescript
   import { createMCPServer } from '@scribe/mcp'
   const server = createMCPServer({ vaultPath: '...' })
   ```

3. **Obsidian Plugin**: Via enzyme's existing plugin bridge
   ```typescript
   import { createAgent } from '@scribe/core'
   // Plugin provides the vault path and file system access
   ```

4. **CLI REPL**: Thin wrapper for standalone use
   ```typescript
   import { createREPL } from '@scribe/repl'
   createREPL({ agent })
   ```

5. **Piped I/O**: For scripting and automation
   ```bash
   echo "Summarize my notes on creativity" | scribe --vault ~/vault
   ```

## Key Difference from Claude Code

Claude Code's architecture:
```
main.tsx → REPL.tsx → query.ts → API → tools
  ↑                                      ↓
  └──── ink rendering ← components ──────┘
```

Everything is entangled with the TUI. The SDK (`@anthropic-ai/claude-code-sdk`) is extracted after the fact.

Scribe's architecture:
```
@scribe/core (agent loop + tools + context management)
     ↑
     ├── @scribe/repl (CLI wrapper)
     ├── @scribe/mcp (MCP server wrapper)
     └── anyone else (Obsidian, web, IDE, etc.)
```

The core is the harness. Everything else is a shell.

## The `transformContext` Pattern (from Pi)

This is the key integration point. Before each LLM call:

```typescript
const agent = createAgent({
  transformContext: async (messages) => {
    // 1. Check if we need compaction
    if (estimateTokens(messages) > threshold) {
      return await compact(messages)
    }

    // 2. Clear old tool results
    messages = clearOldToolResults(messages, keepRecent: 2)

    // 3. Inject enzyme context if topic changed
    const currentTopic = extractTopic(messages)
    if (topicChanged(currentTopic, lastTopic)) {
      const vaultContext = await enzymeCatalyze(currentTopic)
      messages = injectContext(messages, vaultContext)
    }

    return messages
  }
})
```

This single hook handles:
- Compaction (from Claude Code)
- Tool result clearing (from Claude Code)
- Dynamic enzyme context injection (new)

No background processes, no complex service layer. Just a function.

## Workspace Convention

Like Claude Code uses `.claude/` and `CLAUDE.md`, Scribe uses:

```
vault/
├── .scribe/
│   ├── config.yaml      # Model, context size, enzyme settings
│   ├── skills/           # Custom skills (markdown + frontmatter)
│   └── memory/
│       └── MEMORY.md     # Persistent memory (200 line cap)
├── .enzyme/
│   └── enzyme.db         # Enzyme index (already exists)
└── ... vault notes ...
```

The agent reads `.scribe/` for configuration, enzyme reads `.enzyme/` for index. They're complementary.

## Why This Works Better for Writing

1. **The vault IS the workspace**: No need to "bring in content" — enzyme already indexes it
2. **Markdown is the native format**: Both input (vault) and output (drafts) are markdown
3. **Context is pre-compiled**: Enzyme runs before the agent, not during
4. **Small context is a feature**: Forces concise, focused responses — good for writing
5. **Integration over isolation**: Works inside Claude Code, Obsidian, or standalone — not another silo
