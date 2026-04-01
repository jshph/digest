/**
 * Write tool — general-purpose file writer.
 *
 * Mirrors the Claude Code SDK's Write tool signature:
 *   Write(file_path, content)
 *
 * Unlike the vault-scoped WriteFile tool, this writes to any path.
 * Creates parent directories as needed.
 */

import { writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { Tool, ToolResult } from '../core/types.js'

export function createWriteTool(): Tool {
  return {
    definition: {
      name: 'Write',
      description:
        'Writes a file to the local filesystem. Creates parent directories if needed.\n' +
        '\n' +
        'Usage:\n' +
        '- This tool will overwrite the existing file if there is one at the provided path.\n' +
        '- If this is an existing file, you MUST use the Read tool first to read the file\'s contents.\n' +
        '- The file_path parameter must be an absolute path, not a relative path\n' +
        '- Only use this tool to create new files or for complete rewrites.',
      parameters: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['file_path', 'content'],
    },
    execute: async (args): Promise<ToolResult> => {
      const filePath = args.file_path as string
      const content = args.content as string

      try {
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, content, 'utf-8')
        return {
          content: `Wrote ${content.length} chars to ${filePath}`,
          isError: false,
        }
      } catch (err) {
        return {
          content: `Failed to write: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}
