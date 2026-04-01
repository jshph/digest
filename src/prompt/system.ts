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
  return `The vault overview is in the system context above. Relevant content is pre-fetched each turn and appears as "[Vault context for this conversation]" before the user's message. Ground your response in this context — quote passages, notice tensions, connect ideas.

When the user references #tags or [[wikilinks]], use TextSearch to find notes with those entities. TextSearch is ONLY for tags and wikilinks. Never use it for phrases or concepts.

ReadFile takes a file path from TextSearch results (e.g. "inbox/note.md"). Never guess paths — always get them from TextSearch first.

Lead with insight, not process.`
}

function getContextGuidance(): string {
  return `Context is limited. When you find important content, quote key passages in your response — old tool results will be cleared to make room. If the conversation is summarized, pick up where it left off without re-explaining.`
}
