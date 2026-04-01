# Migrating from Claude Code Agent SDK to Digest

Digest is a minimal agent harness (~2,700 LOC) that gives you the same core loop as Claude Code's SDK — tools, streaming, context management — without the subprocess, MCP, permissions, or session infrastructure. You own the agent loop directly.

This doc maps the two SDKs and flags what you gain and lose.

## Quick comparison

| | Claude Code SDK | Digest |
|---|---|---|
| Runtime | Subprocess (spawns CLI, stdio JSONL) | In-process (you call `agent.prompt()`) |
| Agent loop | Harness-owned | You own it (`Agent` class) |
| Tools | MCP protocol + Zod schemas | Plain objects + `tool()` helper |
| Providers | Anthropic only (locked to Claude) | Pluggable (Anthropic, OpenAI-compatible, custom) |
| Context management | Internal | Explicit (compaction, tool result clearing, KV cache warmup) |
| Streaming | Raw Anthropic events via async generator | `AgentEvent` union via `.on(handler)` |
| Session persistence | Built-in (list, resume, fork) | None — bring your own |
| Permissions | 5 modes + `canUseTool` callback | None — all tools execute freely |
| Hooks | 20+ lifecycle events | `prefetch` only |
| Size | ~70K LOC (query.ts + QueryEngine.ts alone) | ~2,700 LOC total |

## Defining tools

**Claude Code SDK:**

```typescript
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const greet = tool(
  'greet',
  'Greet a user',
  { name: z.string().describe('The name to greet') },
  async (args) => ({
    content: [{ type: 'text', text: `Hello, ${args.name}!` }],
  }),
)
```

**Digest:**

```typescript
import { tool } from '@jshph/digest'

const greet = tool(
  'greet',
  'Greet a user',
  {
    parameters: {
      name: { type: 'string', description: 'The name to greet' },
    },
    required: ['name'],
  },
  async (args) => ({
    content: `Hello, ${args.name}!`,
    isError: false,
  }),
)
```

**Key differences:**
- No Zod dependency — parameters are plain `{ type, description }` objects
- Tool results are `{ content: string, isError: boolean }` — text only, no multimodal content arrays
- No MCP wrapping — tools are passed directly to `AgentConfig.tools`

## File tools

Both SDKs ship Read/Write tools. Digest has two variants:

| Tool | Scope | Notes |
|---|---|---|
| `createReadTool()` | Any file path | Mirrors CC SDK's `Read` — line numbers, offset/limit |
| `createWriteTool()` | Any file path | Mirrors CC SDK's `Write` — creates dirs, overwrites |
| `createReadFileTool(vaultPath)` | Vault only | Truncates at 1500 chars, path security check |
| `createWriteFileTool(vaultPath)` | Vault only | Path security check |

Use the general tools for unrestricted access. Use the vault tools when you want sandboxed access with built-in truncation.

Digest does **not** include an `Edit` tool (old_string/new_string replacement). If you need surgical edits, either implement one against the `Tool` interface or use Write to overwrite the full file.

## Streaming events

**Claude Code SDK** — async generator yielding `SDKMessage` variants:

```typescript
const q = query({ prompt: 'hello', options })
for await (const msg of q) {
  if (msg.type === 'assistant') { /* full message */ }
  if (msg.type === 'stream_event') { /* partial delta */ }
  if (msg.type === 'result') { /* terminal with cost/usage */ }
}
```

**Digest** — event handler subscription:

```typescript
agent.on((event) => {
  if (event.type === 'text_delta') process.stdout.write(event.text)
  if (event.type === 'tool_call_start') { /* tool invoked */ }
  if (event.type === 'turn_end') { /* usage available */ }
})
await agent.prompt('hello')
```

No terminal `result` message — `prompt()` resolves when the loop finishes. Access `agent.getMessages()` for the final state.

## Provider setup

**Claude Code SDK** — no provider config, uses Anthropic internally:

```typescript
query({ prompt: 'hello', options: { model: 'claude-sonnet-4-20250514' } })
```

**Digest** — explicit provider wiring:

```typescript
import { Agent, createAnthropicProvider, resolveApiKey } from '@jshph/digest'

const provider = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  apiKey: await resolveApiKey(),
  maxTokens: 4096,
})

const agent = new Agent({
  provider,
  systemPrompt: [{ text: 'You are helpful.', cache: true }],
  tools: [],
  context: { maxTokens: 8192, compactThreshold: 0.7, keepRecentToolResults: 2 },
})
```

You can also use OpenAI-compatible providers (LM Studio, Ollama, etc.) — something CC SDK doesn't support.

## What you lose

- **Session persistence** — no resume, fork, or conversation history across processes. Implement your own serialization over `agent.getMessages()` if needed.
- **Permissions** — all tools execute without checks. Add guards in your tool handlers.
- **Hooks** — no PreToolUse/PostToolUse interception. Wrap tool handlers or use the event system.
- **Edit tool** — no built-in surgical file editing.
- **Subagents** — no agent-within-agent spawning.
- **Bash/Glob/Grep/WebSearch/WebFetch** — no built-in system tools. Implement against the `Tool` interface.
- **Multimodal tool results** — results are strings, not content arrays with images/resources.
- **Budget limits** — no `maxBudgetUsd`. Track cost via `turn_end` events manually.
- **Structured output** — no `outputFormat` with JSON schema.

## What you gain

- **Provider freedom** — use any OpenAI-compatible model, not just Claude.
- **Explicit context control** — you see and configure compaction, tool result clearing, and KV cache warmup. Nothing is hidden.
- **Router/synthesis split** — use a cheap model for tool routing, expensive model for final response.
- **Prefetch** — inject context before the model even sees the prompt, eliminating a tool-call round trip.
- **Prompt cache visibility** — `SystemPromptBlock.cache` gives you direct control over what gets cached.
- **Simplicity** — ~2,700 lines. You can read the entire codebase in an hour.
