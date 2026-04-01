/**
 * Anthropic provider with prompt caching support.
 *
 * Cache strategy:
 *   The system prompt is sent as an array of text blocks. Blocks marked
 *   cache: true get cache_control: { type: 'ephemeral' } on the LAST
 *   cached block, creating a stable prefix. The API caches everything
 *   up to and including that breakpoint.
 *
 *   Tool definitions are part of the cached prefix automatically (the
 *   API hashes system + tools together for the cache key).
 *
 *   Result: on turn 2+, the system prompt + tools + petri overview all
 *   come from KV cache. Only the messages (including new catalyze
 *   results) are new input tokens.
 *
 * For local/OpenAI-compatible endpoints, cache_control is ignored
 * gracefully — the blocks are just concatenated.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  AssistantMessage,
  ContentBlock,
  LLMMessage,
  LLMProvider,
  StreamEvent,
  SystemPromptBlock,
  ToolDefinition,
  TokenUsage,
} from '../types.js'
import { roughTokenEstimate } from '../../context/tokens.js'

export interface AnthropicProviderConfig {
  apiKey?: string
  baseURL?: string
  model?: string
  maxTokens?: number
}

/**
 * Create a provider. Call with `await` — resolves the API key
 * from env or Claude Code's keychain before returning.
 */
export async function createAnthropicProvider(config: AnthropicProviderConfig = {}): Promise<LLMProvider> {
  const { resolveApiKey } = await import('../auth.js')
  const apiKey = config.apiKey || await resolveApiKey()

  const client = new Anthropic({
    apiKey,
    ...(config.baseURL && { baseURL: config.baseURL }),
  })
  const model = config.model || 'claude-haiku-4-5-20251001'
  const maxTokens = config.maxTokens || 2048

  return {
    stream: (systemPrompt, messages, tools, signal) =>
      streamAnthropic(client, model, maxTokens, systemPrompt, messages, tools, signal),
    estimateTokens: roughTokenEstimate,
  }
}

/**
 * Convert SystemPromptBlock[] into Anthropic's system content block array
 * with cache_control breakpoints placed optimally.
 *
 * Places cache_control: { type: 'ephemeral' } on the LAST block where
 * cache === true. This creates the longest possible cached prefix.
 */
function buildSystemBlocks(
  blocks: SystemPromptBlock[],
): Anthropic.TextBlockParam[] {
  // Find the index of the last cached block
  let lastCachedIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].cache) {
      lastCachedIndex = i
      break
    }
  }

  return blocks.map((block, i) => {
    const base: Anthropic.TextBlockParam = {
      type: 'text',
      text: block.text,
    }
    // Place cache breakpoint on the last cached block
    if (i === lastCachedIndex) {
      ;(base as any).cache_control = { type: 'ephemeral' }
    }
    return base
  })
}

async function* streamAnthropic(
  client: Anthropic,
  model: string,
  maxTokens: number,
  systemBlocks: SystemPromptBlock[],
  messages: LLMMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
  const system = buildSystemBlocks(systemBlocks)
  const anthropicMessages = messages.map(toLLMFormat)
  const anthropicTools = tools.length > 0
    ? tools.map(toAnthropicTool)
    : undefined

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      messages: anthropicMessages,
      ...(anthropicTools && { tools: anthropicTools }),
    }, { signal })

    const contentBlocks: ContentBlock[] = []
    let currentToolCall: { id: string; name: string; jsonAccumulator: string } | null = null

    for await (const event of stream) {
      if (signal?.aborted) return

      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block
          if (block.type === 'tool_use') {
            currentToolCall = { id: block.id, name: block.name, jsonAccumulator: '' }
          }
          break
        }

        case 'content_block_delta': {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text }
          } else if (delta.type === 'thinking_delta') {
            yield { type: 'thinking_delta', text: (delta as any).thinking }
          } else if (delta.type === 'input_json_delta' && currentToolCall) {
            currentToolCall.jsonAccumulator += delta.partial_json
          }
          break
        }

        case 'content_block_stop': {
          if (currentToolCall) {
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(currentToolCall.jsonAccumulator || '{}')
            } catch { /* empty args */ }

            contentBlocks.push({
              type: 'tool_call',
              id: currentToolCall.id,
              name: currentToolCall.name,
              arguments: args,
            })

            yield {
              type: 'tool_call',
              id: currentToolCall.id,
              name: currentToolCall.name,
              arguments: args,
            }
            currentToolCall = null
          }
          break
        }

        case 'message_stop': {
          const finalMessage = await stream.finalMessage()
          const textBlocks: ContentBlock[] = finalMessage.content
            .filter(b => b.type === 'text')
            .map(b => ({ type: 'text' as const, text: (b as any).text }))

          const allBlocks = [...textBlocks, ...contentBlocks]
          const usage: TokenUsage = {
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
            cacheReadTokens: (finalMessage.usage as any).cache_read_input_tokens,
            cacheWriteTokens: (finalMessage.usage as any).cache_creation_input_tokens,
          }

          const stopReason = finalMessage.stop_reason === 'tool_use'
            ? 'tool_use' as const
            : finalMessage.stop_reason === 'max_tokens'
              ? 'max_tokens' as const
              : 'end' as const

          yield {
            type: 'done',
            message: {
              role: 'assistant',
              content: allBlocks,
              stopReason,
              timestamp: Date.now(),
              usage,
            },
          }
          return
        }
      }
    }
  } catch (err) {
    yield {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function toLLMFormat(msg: LLMMessage): Anthropic.MessageParam {
  switch (msg.role) {
    case 'user':
      return { role: 'user', content: msg.content }
    case 'assistant':
      return {
        role: 'assistant',
        content: msg.content.map(block => {
          if (block.type === 'text') return { type: 'text' as const, text: block.text }
          if (block.type === 'tool_call') {
            return {
              type: 'tool_use' as const,
              id: block.id,
              name: block.name,
              input: block.arguments,
            }
          }
          return { type: 'text' as const, text: '' }
        }).filter(b => b.type !== 'text' || b.text !== ''),
      }
    case 'tool_result':
      return {
        role: 'user',
        content: [{
          type: 'tool_result' as const,
          tool_use_id: msg.toolCallId,
          content: msg.content,
          is_error: msg.isError,
        }],
      }
  }
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  const properties: Record<string, any> = {}
  for (const [name, param] of Object.entries(tool.parameters)) {
    properties[name] = {
      type: param.type,
      description: param.description,
      ...(param.enum && { enum: param.enum }),
    }
  }

  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties,
      required: tool.required || [],
    },
  }
}
