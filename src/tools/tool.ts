/**
 * tool() — convenience factory for defining tools.
 *
 * Mirrors the shape of the Claude Code Agent SDK's tool() function
 * but produces a native Digest Tool. No Zod dependency required.
 *
 * CC SDK signature (for reference):
 *   tool(name, description, zodSchema, handler, extras?)
 *
 * Digest signature:
 *   tool(name, description, parameters, handler)
 *
 * The parameters object uses Digest's { [key]: ToolParameter } format
 * with an optional `required` array. If you're migrating from CC SDK,
 * replace Zod schemas with plain parameter descriptors — see MIGRATION.md.
 */

import type { Tool, ToolParameter, ToolResult } from '../core/types.js'

export interface ToolParams {
  parameters: Record<string, ToolParameter>
  required?: string[]
}

export function tool(
  name: string,
  description: string,
  schema: ToolParams,
  handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>,
): Tool {
  return {
    definition: {
      name,
      description,
      parameters: schema.parameters,
      required: schema.required,
    },
    execute: handler,
  }
}
