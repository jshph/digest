/**
 * Read tool — general-purpose file reader.
 *
 * Mirrors the Claude Code SDK's Read tool signature:
 *   Read(file_path, offset?, limit?)
 *
 * Unlike the vault-scoped ReadFile tool, this reads any file on disk.
 * Use ReadFile for vault-aware access with truncation; use Read for
 * general file operations.
 */

import { readFile } from 'fs/promises'
import type { Tool, ToolResult } from '../core/types.js'

export function createReadTool(): Tool {
  return {
    definition: {
      name: 'Read',
      description:
        'Reads a file from the local filesystem. Assume this tool can read any file on the machine.\n' +
        '\n' +
        'Usage:\n' +
        '- The file_path parameter must be an absolute path, not a relative path\n' +
        '- By default, it reads up to 2000 lines starting from the beginning of the file\n' +
        '- You can optionally specify a line offset and limit (especially handy for long files), but it\'s recommended to read the whole file by not providing these parameters\n' +
        '- Results are returned using cat -n format, with line numbers starting at 1\n' +
        '- It is okay to read a file that does not exist; an error will be returned\n' +
        '- This tool can only read files, not directories',
      parameters: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (1-based). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read. Optional, defaults to 2000.',
        },
      },
      required: ['file_path'],
    },
    execute: async (args): Promise<ToolResult> => {
      const filePath = args.file_path as string
      const offset = (args.offset as number | undefined) ?? 1
      const limit = (args.limit as number | undefined) ?? 2000

      try {
        const content = await readFile(filePath, 'utf-8')
        const lines = content.split('\n')

        const start = Math.max(0, offset - 1)
        const end = Math.min(lines.length, start + limit)
        const selected = lines.slice(start, end)

        // Format with line numbers (cat -n style)
        const numbered = selected.map((line, i) => {
          const lineNum = String(start + i + 1).padStart(6)
          return `${lineNum}\t${line}`
        }).join('\n')

        const result = lines.length > end
          ? `${numbered}\n\n[${lines.length} lines total, showing ${start + 1}-${end}]`
          : numbered

        return { content: result, isError: false }
      } catch (err) {
        return {
          content: `Failed to read: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}
