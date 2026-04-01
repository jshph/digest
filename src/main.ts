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
import { createOpenAIProvider } from './core/providers/openai.js'
import type { LLMProvider } from './core/types.js'
import { buildSystemPrompt } from './prompt/system.js'
import { createTextSearchTool } from './tools/text-search.js'
import { createVaultSearchTool } from './tools/vault-search.js'
import { createReadFileTool } from './tools/read-file.js'
import { createWriteFileTool } from './tools/write-file.js'
import { createEnzymePrefetch } from './context/prefetch.js'
import { initDebugLog } from './core/debug.js'

const execFileAsync = promisify(execFile)

function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  let vaultPath = process.env.ENZYME_VAULT_ROOT || '.'
  let provider = process.env.SCRIBE_PROVIDER || 'anthropic'
  let model = process.env.SCRIBE_MODEL || ''
  let baseURL = process.env.SCRIBE_BASE_URL || ''
  let maxContext = parseInt(process.env.SCRIBE_MAX_CONTEXT || '8192', 10)
  let routerModel = process.env.SCRIBE_ROUTER_MODEL || ''
  let routerBaseURL = process.env.SCRIBE_ROUTER_BASE_URL || ''

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--provider':
        provider = args[++i]; break
      case '--model':
        model = args[++i]; break
      case '--base-url':
        baseURL = args[++i]; break
      case '--max-context':
        maxContext = parseInt(args[++i], 10); break
      case '--router-model':
        routerModel = args[++i]; break
      case '--router-base-url':
        routerBaseURL = args[++i]; break
      default:
        // First positional arg is vault path
        if (!args[i].startsWith('--')) vaultPath = args[i]
    }
  }

  // Provider defaults
  if (provider === 'lmstudio' && !baseURL) baseURL = 'http://localhost:1234/v1'
  if (provider === 'ollama' && !baseURL) baseURL = 'http://localhost:11434/v1'
  if (!model) {
    model = provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'local-model'
  }

  return { vaultPath: resolve(vaultPath), provider, model, baseURL, maxContext, routerModel, routerBaseURL }
}

async function main() {
  const { vaultPath, provider: providerName, model, baseURL, maxContext, routerModel, routerBaseURL } = parseArgs(process.argv)

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
    const { stdout } = await execFileAsync('enzyme', ['petri', '-p', vaultPath, '-n', '20'], { timeout: 15000 })
    const petri = JSON.parse(stdout)
    const entities = (petri.entities || []).slice(0, 20)
    enzymeOverview = entities
      .map((e: any) => {
        const cats = (e.catalysts || []).slice(0, 3).map((c: any) => c.text).join('; ')
        return `- ${e.name}: ${cats}`
      })
      .join('\n')
    console.log(`enzyme: vault indexed, ${entities.length}/${(petri.entities || []).length} entities`)
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
  if (providerName === 'anthropic') {
    const cachedTokens = systemPrompt.filter(b => b.cache).reduce((sum, b) => sum + Math.ceil(b.text.length / 3.5), 0)
    console.log(`system prompt: ~${promptTokens} tokens (${cachedTokens} cached)`)
  } else {
    console.log(`system prompt: ~${promptTokens} tokens (no cache control)`)
  }
  console.log(`available for conversation: ~${maxContext - promptTokens - 1400} tokens`)
  console.log('')

  let provider: LLMProvider
  const maxTokens = Math.min(2048, Math.floor(maxContext * 0.25))

  if (providerName === 'anthropic') {
    provider = await createAnthropicProvider({
      model,
      maxTokens,
      ...(baseURL && { baseURL }),
    })
  } else {
    // OpenAI-compatible: lmstudio, ollama, or any custom --base-url
    const effectiveBaseURL = baseURL || 'http://localhost:1234/v1'
    provider = createOpenAIProvider({
      baseURL: effectiveBaseURL,
      model,
      maxTokens,
      apiKey: process.env.SCRIBE_API_KEY,
    })
    console.log(`endpoint: ${effectiveBaseURL}`)
  }

  // Optional router provider for tool-call turns (smaller, faster model)
  let routerProvider: LLMProvider | undefined
  if (routerModel) {
    const routerURL = routerBaseURL || baseURL || 'http://localhost:1234/v1'
    routerProvider = createOpenAIProvider({
      baseURL: routerURL,
      model: routerModel,
      maxTokens: 512, // Router only needs to emit tool call JSON
      apiKey: process.env.SCRIBE_API_KEY,
    })
    console.log(`router: ${routerModel} @ ${routerURL}`)
  }

  // Tools
  const tools = [
    createVaultSearchTool(vaultPath),
    createTextSearchTool(vaultPath),
    createReadFileTool(vaultPath),
    createWriteFileTool(vaultPath),
  ]

  const agent = new Agent({
    systemPrompt,
    tools,
    provider,
    ...(routerProvider && { routerProvider }),
    maxToolTurns: 1,
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
