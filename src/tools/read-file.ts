/**
 * ReadFile tool — read a markdown file from the vault.
 */

import { readFile } from 'fs/promises'
import { resolve, relative } from 'path'
import type { Tool, ToolResult } from '../core/types.js'

export function createReadFileTool(vaultPath: string): Tool {
  return {
    definition: {
      name: 'ReadFile',
      description: 'Read a vault file by path. Path MUST come from a TextSearch result (e.g. "inbox/2025-01-15.md"). Never guess paths or use concepts as paths.',
      parameters: {
        path: {
          type: 'string',
          description: 'File path from a TextSearch result (e.g. "Readwise/Articles/title.md").',
        },
      },
      required: ['path'],
    },
    execute: async (args): Promise<ToolResult> => {
      const filePath = args.path as string
      const absPath = resolve(vaultPath, filePath)

      // Security: ensure the resolved path is within the vault
      const rel = relative(vaultPath, absPath)
      if (rel.startsWith('..') || resolve(absPath) !== absPath.replace(/\/$/, '')) {
        // Re-check with resolve to handle symlinks
        if (relative(vaultPath, resolve(absPath)).startsWith('..')) {
          return { content: 'Path is outside the vault.', isError: true }
        }
      }

      try {
        const content = await readFile(absPath, 'utf-8')

        // Truncate very long files to save context
        const MAX_CHARS = 4000
        if (content.length > MAX_CHARS) {
          const truncated = content.slice(0, MAX_CHARS)
          return {
            content: `${truncated}\n\n[Truncated — ${content.length} chars total. First ${MAX_CHARS} shown.]`,
            isError: false,
          }
        }

        return { content, isError: false }
      } catch (err) {
        return {
          content: `Failed to read: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}
