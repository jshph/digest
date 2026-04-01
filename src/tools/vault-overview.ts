/**
 * VaultOverview tool — wraps `enzyme petri` for vault exploration.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Tool, ToolResult } from '../core/types.js'

const execFileAsync = promisify(execFile)

export function createVaultOverviewTool(vaultPath: string): Tool {
  return {
    definition: {
      name: 'VaultOverview',
      description: "See what's in the vault — trending entities, active themes, and catalyst questions. Use this to orient before searching.",
      parameters: {
        top: {
          type: 'number',
          description: 'Number of top entities to show (default: 8)',
        },
        query: {
          type: 'string',
          description: 'Optional query to focus the overview on a topic',
        },
      },
    },
    execute: async (args): Promise<ToolResult> => {
      const top = (args.top as number) || 8
      const query = args.query as string | undefined

      try {
        const cmdArgs = ['petri', '-n', String(top), '-p', vaultPath]
        if (query) cmdArgs.push('-q', query)

        const { stdout } = await execFileAsync('enzyme', cmdArgs, { timeout: 30000 })
        const response = JSON.parse(stdout)

        // Format concisely
        const entities = (response.entities || []).map((e: any) => {
          const catalysts = (e.catalysts || [])
            .slice(0, 2)
            .map((c: any) => `  - ${c.text}`)
            .join('\n')
          const activity = e.last_active ? ` (last active: ${e.last_active})` : ''
          return `**${e.name}** [${e.type}]${activity}\n${catalysts}`
        })

        return {
          content: entities.join('\n\n') || 'No entities found. Is the vault indexed?',
          isError: false,
        }
      } catch (err) {
        return {
          content: `Overview failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}
