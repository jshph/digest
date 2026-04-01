#!/usr/bin/env node

/**
 * Scribe — token-efficient writing agent for Obsidian vaults.
 * Minimal REPL for testing. The real value is the SDK (core/).
 */

import { createInterface } from 'readline'
import { resolve } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'

import { Agent } from './core/agent.js'
import { createAnthropicProvider } from './core/providers/anthropic.js'
import { buildSystemPrompt } from './prompt/system.js'
import { createTextSearchTool } from './tools/text-search.js'
import { createReadFileTool } from './tools/read-file.js'
import { createWriteFileTool } from './tools/write-file.js'
import { createEnzymePrefetch } from './context/prefetch.js'
import { initDebugLog } from './core/debug.js'

const execFileAsync = promisify(execFile)

async function main() {
  const vaultPath = resolve(process.argv[2] || process.env.ENZYME_VAULT_ROOT || '.')
  const model = process.env.SCRIBE_MODEL || 'claude-haiku-4-5-20251001'
  const maxContext = parseInt(process.env.SCRIBE_MAX_CONTEXT || '8192', 10)

  if (process.env.SCRIBE_DEBUG) {
    const debugPath = resolve(process.env.SCRIBE_DEBUG_FILE || 'debug.jsonl')
    await initDebugLog(debugPath)
    console.log(`debug: ${debugPath}`)
  }
  console.log(`scribe v0.1.0`)
  console.log(`vault: ${vaultPath}`)
  console.log(`model: ${model}`)
  console.log(`context: ${maxContext} tokens`)

  // Pre-warm: run enzyme petri for vault overview
  let enzymeOverview: string | undefined
  try {
    const { stdout } = await execFileAsync('enzyme', ['petri', '-p', vaultPath, '-n', '5'], { timeout: 15000 })
    const petri = JSON.parse(stdout)
    enzymeOverview = (petri.entities || [])
      .slice(0, 5)
      .map((e: any) => {
        const cats = (e.catalysts || []).slice(0, 2).map((c: any) => c.text).join('; ')
        return `${e.name}: ${cats}`
      })
      .join('\n')
    console.log(`enzyme: vault indexed, ${(petri.entities || []).length} entities`)
  } catch {
    console.log('enzyme: not available or vault not indexed')
  }

  // Load memory if it exists
  let memoryContent: string | undefined
  try {
    const memPath = resolve(vaultPath, '.scribe', 'memory', 'MEMORY.md')
    memoryContent = await readFile(memPath, 'utf-8')
    // Cap at 200 lines (same as Claude Code)
    const lines = memoryContent.split('\n')
    if (lines.length > 200) {
      memoryContent = lines.slice(0, 200).join('\n') + '\n[truncated]'
    }
  } catch { /* no memory file */ }

  const systemPrompt = buildSystemPrompt({
    vaultName: vaultPath.split('/').pop(),
    enzymeOverview,
    memoryContent,
  })

  // Log token budget
  const promptTokens = systemPrompt.reduce((sum, b) => sum + Math.ceil(b.text.length / 3.5), 0)
  const cachedTokens = systemPrompt.filter(b => b.cache).reduce((sum, b) => sum + Math.ceil(b.text.length / 3.5), 0)
  console.log(`system prompt: ~${promptTokens} tokens (${cachedTokens} cached)`)
  console.log(`available for conversation: ~${maxContext - promptTokens - 1400} tokens`)
  console.log('')

  const provider = await createAnthropicProvider({
    model,
    maxTokens: Math.min(2048, Math.floor(maxContext * 0.25)),
    ...(process.env.SCRIBE_BASE_URL && { baseURL: process.env.SCRIBE_BASE_URL }),
  })

  // Tools: TextSearch for #tag/[[wikilink]] lookups, ReadFile for full
  // notes, WriteFile for drafting. VaultSearch and VaultOverview are NOT
  // tools — catalyze runs via prefetch, petri is in the system prompt.
  const tools = [
    createTextSearchTool(vaultPath),
    createReadFileTool(vaultPath),
    createWriteFileTool(vaultPath),
  ]

  const agent = new Agent({
    systemPrompt,
    tools,
    provider,
    context: {
      maxTokens: maxContext,
      compactThreshold: 0.70,
      keepRecentToolResults: 2,
    },
    prefetch: createEnzymePrefetch(vaultPath),
  })

  // Token tracking
  let sessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let turnCount = 0

  agent.on((event) => {
    switch (event.type) {
      case 'prefetch_start':
        process.stdout.write(`[${event.source}] `)
        break
      case 'prefetch_end':
        process.stdout.write(event.found ? 'context found\n' : 'no matches\n')
        break
      case 'text_delta':
        process.stdout.write(event.text)
        break
      case 'tool_call_start':
        process.stdout.write(`\n[${event.name}] `)
        break
      case 'tool_call_end':
        if (event.result.isError) {
          process.stdout.write(`error: ${event.result.content}\n`)
        } else {
          const preview = event.result.content.slice(0, 100).replace(/\n/g, ' ')
          process.stdout.write(`${preview}${event.result.content.length > 100 ? '...' : ''}\n`)
        }
        break
      case 'turn_end':
        turnCount++
        if (event.usage) {
          sessionTokens.input += event.usage.inputTokens
          sessionTokens.output += event.usage.outputTokens
          sessionTokens.cacheRead += event.usage.cacheReadTokens || 0
          sessionTokens.cacheWrite += event.usage.cacheWriteTokens || 0
          const cached = event.usage.cacheReadTokens || 0
          const total = event.usage.inputTokens + (event.usage.cacheReadTokens || 0) + (event.usage.cacheWriteTokens || 0)
          process.stderr.write(
            `\n[turn ${turnCount}] in: ${event.usage.inputTokens} out: ${event.usage.outputTokens}` +
            (cached > 0 ? ` cache_read: ${cached}` : '') +
            (event.usage.cacheWriteTokens ? ` cache_write: ${event.usage.cacheWriteTokens}` : '') +
            ` | session: ${sessionTokens.input + sessionTokens.cacheRead + sessionTokens.cacheWrite} in, ${sessionTokens.output} out` +
            (sessionTokens.cacheRead > 0 ? ` (${sessionTokens.cacheRead} from cache)` : '') +
            '\n',
          )
        }
        break
      case 'compact_start':
        process.stdout.write('\n[compacting context...]\n')
        break
      case 'compact_end':
        process.stdout.write('[context compacted]\n')
        break
      case 'error':
        console.error(`\nerror: ${event.error}`)
        break
      case 'agent_end':
        process.stdout.write('\n')
        break
    }
  })

  // Piped mode: read all stdin, process the first non-empty line, exit.
  // Interactive mode: REPL loop.
  if (!process.stdin.isTTY) {
    const lines: string[] = []
    const rl = createInterface({ input: process.stdin })
    for await (const line of rl) {
      const trimmed = line.trim()
      if (trimmed) lines.push(trimmed)
    }
    if (lines.length > 0) {
      await agent.prompt(lines.join('\n'))
    }
    process.exit(0)
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  })

  rl.prompt()
  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) { rl.prompt(); return }
    if (input === '/quit' || input === '/exit') { rl.close(); return }
    if (input === '/context') {
      const msgs = agent.getMessages()
      console.log(`Messages: ${msgs.length}`)
      console.log(`Est. tokens: ~${Math.ceil(JSON.stringify(msgs).length / 3.5)}`)
      rl.prompt()
      return
    }
    await agent.prompt(input)
    rl.prompt()
  })
  rl.on('close', () => process.exit(0))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
