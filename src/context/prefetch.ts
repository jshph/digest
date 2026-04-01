/**
 * Vault context pre-fetch via Enzyme.
 *
 * Runs `enzyme catalyze` on the user's recent messages before the LLM
 * sees the prompt. The results are injected as context so the model
 * can reason about vault content immediately — no tool-call round trip.
 *
 * The catalysts in the results serve a dual purpose:
 *   1. Surface relevant content (the obvious one)
 *   2. Signal familiarity — if catalysts match strongly, the user has
 *      been thinking about this topic. If nothing resonates, it's new
 *      territory. The model can calibrate its response accordingly.
 *
 * This replaces VaultSearch as a tool. The agent still has TextSearch
 * and ReadFile for going deeper, but the initial context retrieval
 * is automatic.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Message, PrefetchResult, UserMessage } from '../core/types.js'

const exec = promisify(execFile)

/**
 * Create a prefetch function for a given vault path.
 * Pass the returned function as `config.prefetch` in AgentConfig.
 */
export function createEnzymePrefetch(vaultPath: string) {
  return async (recentMessages: Message[]): Promise<PrefetchResult | null> => {
    // Build a search query from recent user messages.
    // Using the last 3 gives the model topical continuity —
    // if the conversation has evolved, the query reflects that.
    const userTexts = recentMessages
      .filter((m): m is UserMessage => m.role === 'user')
      .map(m => m.content)
    // Strip vault syntax (#tags, [[wikilinks]]) from the query.
    // These are entity anchors meant for TextSearch (grep), not catalyze.
    // Catalyze works on concepts — "founding" not "#founding".
    const raw = userTexts.join(' ').slice(0, 500)
    const query = raw
      .replace(/\[\[([^\]]+)\]\]/g, '$1')  // [[link]] → link
      .replace(/#([\w/.-]+)/g, '$1')        // #tag → tag
      .trim()

    if (!query.trim()) return null

    try {
      const { stdout } = await exec(
        'enzyme',
        ['catalyze', query, '-n', '5', '-p', vaultPath],
        { timeout: 15_000 },
      )

      const response = JSON.parse(stdout)
      const results = (response.results || []) as Array<{
        file_path: string
        content: string
        similarity: number
      }>

      if (results.length === 0) return null

      // Format concisely — this goes into the context window
      const excerpts = results.map(r => {
        const path = r.file_path.replace(vaultPath + '/', '')
        const excerpt = r.content.slice(0, 300).trim()
        return `**${path}** (${(r.similarity * 100).toFixed(0)}% match)\n${excerpt}`
      })

      const catalysts = (response.top_contributing_catalysts || [])
        .slice(0, 3)
        .map((c: any) => `- ${c.text} (${c.entity})`)

      let content = excerpts.join('\n\n---\n\n')
      if (catalysts.length > 0) {
        content += `\n\nThemes connecting these results:\n${catalysts.join('\n')}`
      }

      return { content, source: 'enzyme catalyze' }
    } catch {
      return null // Enzyme not available or query failed — not an error
    }
  }
}
