/**
 * The agent loop.
 *
 * This is the core of the system. Everything else — tools, providers,
 * context management — exists to serve this loop.
 *
 * The loop is simple:
 *
 *   1. User sends a message
 *   2. (Context check: compact or clear old tool results if needed)
 *   3. Send conversation to the LLM
 *   4. If the LLM responds with text only → done
 *   5. If the LLM calls tools → execute them, append results, go to 2
 *
 * That's it. Claude Code does this in ~70K lines (query.ts + QueryEngine.ts).
 * The complexity there comes from permissions, MCP, IDE bridging, subagents,
 * analytics, and enterprise features. None of that is intrinsic to the loop.
 */

import type {
  AgentConfig,
  AgentEvent,
  AssistantMessage,
  ContentBlock,
  LLMMessage,
  Message,
  PrefetchResult,
  SystemPromptBlock,
  ToolCallContent,
  ToolResult,
  ToolResultMessage,
  UserMessage,
} from './types.js'
import { estimateMessageTokens, shouldCompact } from '../context/tokens.js'
import { compactMessages } from '../context/compact.js'
import { clearOldToolResults } from '../context/clearing.js'
import {
  isDebugEnabled, logCompact, logLLMRequest, logLLMResponse,
  logPrefetch, logPrefixCheck, logSystemPrompt, logToolCall,
} from './debug.js'

export type EventHandler = (event: AgentEvent) => void | Promise<void>

export class Agent {
  private messages: Message[] = []
  private config: AgentConfig
  private listeners: EventHandler[] = []
  private abortController: AbortController | null = null

  constructor(config: AgentConfig) {
    this.config = config
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  on(handler: EventHandler): () => void {
    this.listeners.push(handler)
    return () => { this.listeners = this.listeners.filter(h => h !== handler) }
  }

  /** Read the conversation history. */
  getMessages(): readonly Message[] {
    return this.messages
  }

  /** Cancel the current run. */
  abort(): void {
    this.abortController?.abort()
  }

  /** Send a user message and run the agent loop until it completes. */
  async prompt(text: string): Promise<void> {
    // Clear old tool results BEFORE the new user message, so stubs are
    // baked into the prefix. This keeps the prefix stable during the
    // tool-call loop (KV cache hits on every turn within a prompt).
    this.messages = clearOldToolResults(
      this.messages,
      this.config.context.keepRecentToolResults,
    )

    this.messages.push({
      role: 'user',
      content: text,
      timestamp: Date.now(),
    } satisfies UserMessage)

    await this.emit({ type: 'agent_start' })

    // Pre-fetch: run enzyme catalyze (or whatever prefetch is configured)
    // on recent messages BEFORE the LLM sees the prompt. The results
    // are injected as context so the model reasons about vault content
    // immediately rather than deciding whether to search first.
    await this.runPrefetch()

    await this.runLoop()
    await this.emit({ type: 'agent_end' })

    // Warm the KV cache for the next prompt. Clear tool results to get
    // the stubbed prefix, then fire a max_tokens=1 request so the
    // backend processes and caches the prefix while the user thinks.
    this.warmKVCache()
  }

  // ── Pre-fetch ────────────────────────────────────────────────────
  //
  // Runs before the first LLM call of each prompt(). Takes the last
  // few user messages, passes them to the prefetch function (typically
  // enzyme catalyze), and injects results as a context message.
  //
  // The model sees: [user messages...] [prefetched vault context] [latest user message]
  //
  // This eliminates a tool-call round trip. Instead of:
  //   user → LLM decides to search → tool call → results → LLM responds
  // It becomes:
  //   user → prefetch runs in parallel → LLM sees results immediately → responds
  //
  // The catalysts in the results also signal whether the user has been
  // thinking about this topic (familiar territory) or not.

  private async runPrefetch(): Promise<void> {
    if (!this.config.prefetch) return

    // Gather recent user messages (last 3) as search context
    const recentUserMessages = this.messages
      .filter((m): m is UserMessage => m.role === 'user')
      .slice(-3)

    if (recentUserMessages.length === 0) return

    const source = 'enzyme catalyze'
    await this.emit({ type: 'prefetch_start', source })

    const queryText = recentUserMessages.map(m => m.content).join(' ').slice(0, 300)

    try {
      const result = await this.config.prefetch(recentUserMessages)
      await logPrefetch(queryText, result)
      if (result) {
        const lastUserIndex = this.messages.length - 1
        this.messages.splice(lastUserIndex, 0, {
          role: 'user',
          content: `[Vault context for this conversation]\n\n${result.content}`,
          timestamp: Date.now(),
        } satisfies UserMessage)
        await this.emit({ type: 'prefetch_end', source: result.source, found: true })
      } else {
        await this.emit({ type: 'prefetch_end', source, found: false })
      }
    } catch {
      await logPrefetch(queryText, null)
      await this.emit({ type: 'prefetch_end', source, found: false })
    }
  }

  // ── The loop ─────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    this.abortController = new AbortController()
    const { signal } = this.abortController
    const maxTurns = this.config.maxToolTurns ?? 5
    let turn = 0

    while (!signal.aborted && turn < maxTurns) {
      turn++
      await this.manageContext()
      await this.emit({ type: 'turn_start' })

      // Use router provider for tool-call turns if available,
      // main provider for text responses and forced synthesis.
      const useRouter = turn <= maxTurns && !!this.config.routerProvider

      // While the router works, warm the synthesis model's KV cache
      // with the current prefix (system prompt + messages so far).
      // By the time the router returns and we need synthesis, the
      // prefix is already cached — only the new suffix gets processed.
      if (useRouter && this.config.provider.warmup) {
        this.config.provider.warmup(
          this.config.systemPrompt,
          this.toLLMMessages(),
        )
      }

      const response = await this.callModel(signal, useRouter ? 'router' : 'main')
      if (!response) break
      this.messages.push(response)

      // Text-only response → conversation turn is complete
      const toolCalls = response.content.filter(
        (b): b is ToolCallContent => b.type === 'tool_call',
      )
      if (toolCalls.length === 0) {
        await this.emit({ type: 'turn_end', usage: response.usage })
        break
      }

      // Execute tool calls in parallel — they were all decided
      // before any execute, so they're independent of each other.
      const results = await Promise.all(
        toolCalls.map(call =>
          signal.aborted
            ? Promise.resolve({ call, result: { content: 'Aborted', isError: true } })
            : this.executeTool(call, signal).then(result => ({ call, result }))
        ),
      )
      for (const { call, result } of results) {
        this.messages.push({
          role: 'tool_result',
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          isError: result.isError,
          timestamp: Date.now(),
        } satisfies ToolResultMessage)
      }

      await this.emit({ type: 'turn_end', usage: response.usage })
      // Loop back — the model needs to see the tool results
    }

    // Hit the turn cap — nudge the model to respond with what it has
    if (turn >= maxTurns && !signal.aborted) {
      this.messages.push({
        role: 'user',
        content: 'You have enough context now. Respond to the user with what you have gathered. Do not call any more tools.',
        timestamp: Date.now(),
      } satisfies UserMessage)
      await this.emit({ type: 'turn_start' })
      const finalResponse = await this.callModel(signal, 'main')
      if (finalResponse) {
        this.messages.push(finalResponse)
        await this.emit({ type: 'turn_end', usage: finalResponse.usage })
      }
    }

    this.abortController = null
  }

  // ── Tool execution ───────────────────────────────────────────────

  private async executeTool(call: ToolCallContent, signal: AbortSignal): Promise<ToolResult> {
    await this.emit({ type: 'tool_call_start', id: call.id, name: call.name, args: call.arguments })

    const tool = this.config.tools.find(t => t.definition.name === call.name)
    let result: ToolResult

    if (!tool) {
      result = { content: `Unknown tool "${call.name}"`, isError: true }
    } else {
      try {
        result = await tool.execute(call.arguments, signal)
      } catch (err) {
        result = { content: err instanceof Error ? err.message : String(err), isError: true }
      }
    }

    await logToolCall(call.name, call.arguments, result.content, result.isError)
    await this.emit({ type: 'tool_call_end', id: call.id, name: call.name, result })
    return result
  }

  // ── Context management ───────────────────────────────────────────
  //
  // Two mechanisms keep the conversation within the token budget:
  //
  //   1. Tool result clearing — old results are replaced with one-line
  //      stubs. Cheap, runs every turn. (see context/clearing.ts)
  //
  //   2. Compaction — when the estimated token count exceeds the
  //      threshold, older messages are summarized into a single
  //      SystemCompactMessage. (see context/compact.ts)

  private async manageContext(): Promise<void> {
    // Note: tool result clearing is done in prompt() — not here —
    // so the prefix stays stable during the tool-call loop (KV cache).
    if (shouldCompact(this.estimateTokens(), this.config.context)) {
      await this.emit({ type: 'compact_start' })
      const beforeCount = this.messages.length
      const { messages, summary } = await compactMessages(this.messages, this.config)
      this.messages = messages
      await logCompact(beforeCount, messages.length, summary.length)
      await this.emit({ type: 'compact_end', summary })
    }
  }

  private estimateTokens(): number {
    const est = this.config.provider.estimateTokens
    let tokens = 0
    for (const block of this.config.systemPrompt) tokens += est(block.text)
    for (const tool of this.config.tools) tokens += est(JSON.stringify(tool.definition))
    for (const msg of this.messages) tokens += estimateMessageTokens(msg, est)
    return tokens
  }

  // ── LLM call ─────────────────────────────────────────────────────
  //
  // Converts the internal Message[] to LLMMessage[] (what the model
  // sees), streams the response, and emits text/thinking deltas as
  // they arrive. Returns the completed AssistantMessage, or null on
  // error/abort.

  private lastSerializedPrefix: string | null = null

  private async callModel(signal: AbortSignal, which: 'main' | 'router' = 'main'): Promise<AssistantMessage | null> {
    const llmMessages = this.toLLMMessages()
    const toolDefs = this.config.tools.map(t => t.definition)
    const provider = which === 'router' && this.config.routerProvider
      ? this.config.routerProvider
      : this.config.provider

    // Check KV cache prefix stability across turns
    this.checkPrefixStability(llmMessages)

    await logSystemPrompt(this.config.systemPrompt)
    await logLLMRequest(llmMessages, toolDefs, this.estimateTokens())

    const stream = provider.stream(
      this.config.systemPrompt,
      llmMessages,
      toolDefs,
      signal,
    )

    for await (const event of stream) {
      if (signal.aborted) return null
      switch (event.type) {
        case 'text_delta':
          await this.emit({ type: 'text_delta', text: event.text })
          break
        case 'thinking_delta':
          await this.emit({ type: 'thinking_delta', text: event.text })
          break
        case 'done':
          await logLLMResponse(event.message.usage, event.message.stopReason)
          return event.message
        case 'error':
          await this.emit({ type: 'error', error: event.error })
          return null
      }
    }

    return null
  }

  // Convert internal messages to the format the LLM provider expects.
  // SystemCompactMessages become user messages with a framing prefix
  // so the model knows it's reading a summary, not the original exchange.
  private toLLMMessages(): LLMMessage[] {
    return this.messages.flatMap((msg): LLMMessage[] => {
      switch (msg.role) {
        case 'user':
          return [{ role: 'user', content: msg.content }]
        case 'assistant':
          return [{ role: 'assistant', content: msg.content }]
        case 'tool_result':
          return [{ role: 'tool_result', toolCallId: msg.toolCallId, content: msg.content, isError: msg.isError }]
        case 'system_compact':
          return [{ role: 'user', content: `[Previous conversation summary]\n\n${msg.summary}\n\n[Continuing from where we left off]` }]
      }
    })
  }

  /**
   * Compare the serialized prompt prefix against the previous turn.
   * If the prefix diverges, KV cache reuse is broken for that turn.
   * Logs to debug output when enabled.
   */
  private checkPrefixStability(llmMessages: LLMMessage[]): void {
    if (!isDebugEnabled()) return

    // Serialize system prompt + all messages except the last one
    // (the last message is the new content — everything before it should match)
    const systemSerialized = this.config.systemPrompt.map(b => b.text).join('\n\n')
    const msgsSerialized = llmMessages.map(m => {
      if (m.role === 'user') return `user:${m.content}`
      if (m.role === 'tool_result') return `tool:${m.toolCallId}:${m.content}`
      if (m.role === 'assistant') return `assistant:${JSON.stringify(m.content)}`
      return ''
    }).join('\n')
    const fullSerialized = systemSerialized + '\n' + msgsSerialized

    if (this.lastSerializedPrefix !== null) {
      // Find where current and previous diverge
      const prev = this.lastSerializedPrefix
      const curr = fullSerialized
      const minLen = Math.min(prev.length, curr.length)
      let divergeAt = -1
      for (let i = 0; i < minLen; i++) {
        if (prev[i] !== curr[i]) {
          divergeAt = i
          break
        }
      }

      if (divergeAt === -1 && prev.length <= curr.length) {
        // Previous is a prefix of current — cache should hit
        logPrefixCheck(true, prev.length, curr.length, null)
      } else {
        // Divergence found
        const ctx = curr.slice(Math.max(0, divergeAt - 40), divergeAt + 40)
        logPrefixCheck(false, prev.length, curr.length, {
          position: divergeAt,
          prevSnippet: prev.slice(Math.max(0, divergeAt - 20), divergeAt + 20),
          currSnippet: curr.slice(Math.max(0, divergeAt - 20), divergeAt + 20),
        })
      }
    }

    this.lastSerializedPrefix = fullSerialized
  }

  /**
   * Fire-and-forget: clear old tool results to get the stubbed prefix,
   * then send a warmup request so the backend caches it while the user
   * is thinking about their next message.
   */
  private warmKVCache(): void {
    if (!this.config.provider.warmup) return

    const stubbedMessages = clearOldToolResults(
      this.messages,
      this.config.context.keepRecentToolResults,
    )
    const llmMessages = stubbedMessages.flatMap((msg): LLMMessage[] => {
      switch (msg.role) {
        case 'user':
          return [{ role: 'user', content: msg.content }]
        case 'assistant':
          return [{ role: 'assistant', content: msg.content }]
        case 'tool_result':
          return [{ role: 'tool_result', toolCallId: msg.toolCallId, content: msg.content, isError: msg.isError }]
        case 'system_compact':
          return [{ role: 'user', content: `[Previous conversation summary]\n\n${msg.summary}\n\n[Continuing from where we left off]` }]
      }
    })

    this.config.provider.warmup(this.config.systemPrompt, llmMessages)
  }

  private async emit(event: AgentEvent): Promise<void> {
    for (const handler of this.listeners) await handler(event)
  }
}
