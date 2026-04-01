/**
 * Digest SDK — public API.
 * Import from 'digest' to build your own integration.
 */

// Core
export { Agent } from './core/agent.js'
export type {
  AgentConfig,
  AgentEvent,
  ContextConfig,
  LLMProvider,
  Message,
  SystemPromptBlock,
  Tool,
  ToolDefinition,
  ToolResult,
  StreamEvent,
} from './core/types.js'

// Provider
export { createAnthropicProvider } from './core/providers/anthropic.js'
export type { AnthropicProviderConfig } from './core/providers/anthropic.js'
export { resolveApiKey } from './core/auth.js'

// Tools
export { createTextSearchTool } from './tools/text-search.js'
export { createReadFileTool } from './tools/read-file.js'
export { createWriteFileTool } from './tools/write-file.js'

// Prompt
export { buildSystemPrompt } from './prompt/system.js'
export type { PromptConfig } from './prompt/system.js'

// Context
export { roughTokenEstimate } from './context/tokens.js'
export { createEnzymePrefetch } from './context/prefetch.js'
