/**
 * System prompt construction with cache-aware block structure.
 *
 * The prompt is split into CACHED and UNCACHED blocks:
 *
 *   CACHED (stable across turns, gets KV-cache hits):
 *     Block 1: identity + tool guidance + context guidance
 *     Block 2: enzyme petri overview (constant for session)
 *
 *   UNCACHED (may change per turn):
 *     Block 3: memory (user may update mid-session)
 *     Block 4: date / env
 *
 * The provider places cache_control: { type: 'ephemeral' } on the LAST
 * cached block. Everything before it is the prefix that gets cached.
 * Tool definitions are also cached by the API automatically.
 *
 * This means: system prompt + tools + petri = cached prefix.
 * Only memory/date/messages vary per turn.
 * On a 5-turn conversation with VaultSearch calls, turns 2-5 get full
 * cache hits on the prefix — time to first token drops dramatically.
 */

import type { SystemPromptBlock } from '../core/types.js'

export interface PromptConfig {
  vaultName?: string
  enzymeOverview?: string  // Pre-warmed petri output (stable for session)
  memoryContent?: string   // MEMORY.md content (may change)
  date?: string
}

export function buildSystemPrompt(config: PromptConfig = {}): SystemPromptBlock[] {
  const date = config.date || new Date().toISOString().split('T')[0]
  const blocks: SystemPromptBlock[] = []

  // --- CACHED BLOCK (stable across turns) ---
  //
  // Identity + tool guidance + context guidance + petri overview are merged
  // into a SINGLE cached block. This ensures the cached prefix exceeds
  // Haiku's 1,024 token minimum for cache activation. Splitting into
  // multiple small blocks risks each being under the threshold.

  const cachedParts = [getIdentity(), getToolGuidance(), getContextGuidance()]

  if (config.enzymeOverview) {
    const header = config.vaultName
      ? `# Vault "${config.vaultName}" overview`
      : '# Vault overview'
    cachedParts.push(`${header}\n${config.enzymeOverview}`)
  }

  blocks.push({
    text: cachedParts.join('\n\n'),
    cache: true,
  })

  // --- UNCACHED BLOCKS (may change per turn) ---

  // Block 3: Memory (user may ask to update mid-session)
  if (config.memoryContent) {
    blocks.push({
      text: `# Memory\n${config.memoryContent}`,
      cache: false,
    })
  }

  // Block 4: Date/environment (changes daily, trivially small)
  const envParts = [`Date: ${date}`]
  if (config.vaultName) envParts.push(`Vault: ${config.vaultName}`)
  blocks.push({
    text: envParts.join('\n'),
    cache: false,
  })

  return blocks
}

function getIdentity(): string {
  return `You are a writing and thinking assistant. You work with the user's vault of markdown notes to help them develop ideas, draft writing, and explore connections.

When exploring ideas, surface connections the user might not see. When drafting, match the user's voice from their existing writing. When organizing, respect their existing structure (tags, links, folders).`
}

function getToolGuidance(): string {
  return `The vault overview is in the system context above. Each turn, catalyst questions and entity names appear as "[Vault context for this conversation]". Use both on your first tool call:
- VaultSearch: semantic search by concept. Write queries from catalyst questions + user intent. Results include full excerpts — often enough to synthesize from directly.
- TextSearch: exact match for #tags and [[wikilinks]]. Use the entity names from the vault context (e.g. if you see "craft", search for "#craft"; if you see "enzyme/pmf", search for "[[enzyme/pmf]]").
Call both VaultSearch and TextSearch in parallel on your first turn to maximize coverage.

ReadFile: only use when the user asks to go deeper into a specific note. Never read files proactively — synthesize from VaultSearch excerpts first, then offer to read specific files if the user wants more detail.

After synthesizing, offer the user 2-3 specific notes they can explore in detail. Lead with insight, not process.`
}

function getContextGuidance(): string {
  return `Context is limited. When you find important content, quote key passages in your response — old tool results will be cleared to make room. If the conversation is summarized, pick up where it left off without re-explaining.`
}
