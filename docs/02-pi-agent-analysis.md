# Pi Agent Analysis: The Minimal Agent Loop

Source: `badlogic/pi-mono` — cloned to `/Users/joshuapham/Hacks/pi-agent/`

## Architecture Overview

Pi is a monorepo with cleanly separated concerns:

| Package | Lines | Purpose |
|---------|-------|---------|
| `agent` | 1,859 | Agent runtime (the core loop) |
| `ai` | 26,575 | Multi-provider LLM API abstraction |
| `coding-agent` | ~large | The actual coding CLI (domain-specific) |
| `tui` | ~med | Terminal UI library |
| `web-ui` | ~med | Web components for chat |

## The Agent Core (~1,859 lines)

This is the pattern to follow. Only 5 files:

- `agent.ts` — Agent class with state management, event system, queueing
- `agent-loop.ts` — The actual loop: prompt → stream → tool calls → repeat
- `types.ts` — All types (AgentMessage, AgentTool, AgentContext, AgentEvent, etc.)
- `proxy.ts` — Agent proxy utilities
- `index.ts` — Exports

### Key Design Decisions

1. **AgentMessage vs Message separation**: AgentMessages can be custom types (UI notifications, artifacts) that get filtered out before LLM calls via `convertToLlm()`
2. **transformContext hook**: Applied before each LLM call — this is where context window management goes (pruning, compaction)
3. **Tool lifecycle hooks**: `beforeToolCall` and `afterToolCall` — block, modify, or audit tool executions
4. **Steering messages**: `getSteeringMessages()` injects messages mid-run (like system reminders)
5. **Follow-up messages**: `getFollowUpMessages()` for continuing after the agent would stop
6. **Event stream**: Clean event types (agent_start/end, turn_start/end, message_start/update/end, tool_execution_*)
7. **Tool execution modes**: Sequential or parallel tool execution

### The Loop Pattern

```
prompt → convertToLlm(messages) → streamSimple(model, messages, tools)
  → assistant message → execute tool calls → tool results → repeat
  → check steering messages → check follow-up messages → stop or continue
```

### What's Brilliant for a Writing Agent

- **The 1,859-line core is provider-agnostic** — works with any LLM
- **transformContext is the integration point** for enzyme pre-processing
- **convertToLlm decouples UI messages from LLM messages** — custom message types for writing context (vault excerpts, research, outlines) that get converted/filtered before hitting the model
- **beforeToolCall/afterToolCall hooks** — perfect for validating/transforming enzyme queries
- **Steering messages** — could inject enzyme context mid-conversation as the topic evolves

### What a Writing Agent Would Change

- Strip the `ai` package's multi-provider abstraction to just 1-2 providers (local + Claude)
- Replace coding tools with writing tools (enzyme catalyze, read vault, write draft, etc.)
- Add compaction (Pi doesn't have it — that's from Claude Code)
- The TUI is separate and optional — could be replaced with a simple REPL or just piped I/O
