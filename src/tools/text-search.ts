/**
 * TextSearch — find notes by vault entity (tags and wikilinks).
 *
 * This tool searches for structural entities that exist in the vault's
 * markup: #tags (in frontmatter and inline) and [[wikilinks]]. These
 * are the vault's own organizational vocabulary — they appear verbatim
 * in notes and are reliable grep targets.
 *
 * Do NOT use this for general phrases or concepts — that's what the
 * automatic catalyze prefetch handles. TextSearch is strictly for
 * entities the user references with vault syntax (#tag or [[link]]).
 *
 * Examples of correct use:
 *   TextSearch("enzyme/pmf")        — tag (omit # to catch both forms)
 *   TextSearch("[[open questions]]") — wikilink
 *   TextSearch("founding")          — tag that appears in frontmatter
 *
 * Examples of INCORRECT use:
 *   TextSearch("product market fit") — a phrase, not an entity. Prefetch handles this.
 *   TextSearch("feeling stuck")      — a concept. Prefetch handles this.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Tool, ToolResult } from '../core/types.js'

const exec = promisify(execFile)

export function createTextSearchTool(vaultPath: string): Tool {
  return {
    definition: {
      name: 'TextSearch',
      description:
        'Find notes by #tag or [[wikilink]]. Omit # for tags. Never use for phrases or concepts.',
      parameters: {
        query: {
          type: 'string',
          description: 'Tag name (without #) or [[wikilink]].',
        },
      },
      required: ['query'],
    },

    async execute(args): Promise<ToolResult> {
      const raw = args.query as string
      // Strip [[ ]] wrapper if present — grep for the inner text
      const query = raw.replace(/^\[\[|\]\]$/g, '')

      try {
        // Step 1: find which files contain the entity
        const { stdout: fileList } = await exec(
          'grep', ['-r', '-l', '-i', '--include', '*.md', query, vaultPath],
          { timeout: 10_000, maxBuffer: 64 * 1024 },
        )
        const files = fileList.trim().split('\n').filter(Boolean)
        if (files.length === 0) return { content: `No notes found for "${raw}"`, isError: false }

        // Step 2: get matching lines with 1 line of context
        const maxFiles = Math.min(files.length, 8)
        const { stdout: matches } = await exec(
          'grep', ['-r', '-n', '-i', '--include', '*.md', '-C', '1', query, ...files.slice(0, maxFiles)],
          { timeout: 10_000, maxBuffer: 64 * 1024 },
        )

        // Strip vault path prefix for readability
        const vaultPrefix = new RegExp(
          vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/',
          'g',
        )
        let output = matches.replace(vaultPrefix, '').trim()

        if (output.length > 2000) {
          output = output.slice(0, 2000)
        }
        if (files.length > maxFiles) {
          output += `\n\n[${files.length} notes matched, showing first ${maxFiles}]`
        }

        return { content: output, isError: false }
      } catch (err: any) {
        if (err.code === 1) return { content: `No notes found for "${raw}"`, isError: false }
        return { content: `Search failed: ${err.message || err}`, isError: true }
      }
    },
  }
}
