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

  const isTTYBanner = process.stderr.isTTY
  const dim = (s: string) => isTTYBanner ? `\x1b[2m${s}\x1b[0m` : s

  if (process.env.SCRIBE_DEBUG) {
    const debugPath = resolve(process.env.SCRIBE_DEBUG_FILE || 'debug.jsonl')
    await initDebugLog(debugPath)
    process.stderr.write(dim(`debug: ${debugPath}\n`))
  }
  process.stderr.write(`scribe v0.1.0 ${dim(`· ${model} · ${maxContext} tokens`)}\n`)
  process.stderr.write(dim(`vault: ${vaultPath}\n`))

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
    process.stderr.write(dim(`enzyme: ${entities.length} entities indexed\n`))
  } catch {
    process.stderr.write(dim('enzyme: not available\n'))
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

  const promptTokens = systemPrompt.reduce((sum, b) => sum + Math.ceil(b.text.length / 3.5), 0)
  process.stderr.write(dim(`prompt: ~${promptTokens} tokens · ~${maxContext - promptTokens - 1400} available\n`))

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
    process.stderr.write(dim(`endpoint: ${effectiveBaseURL}\n`))
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
    process.stderr.write(dim(`router: ${routerModel}\n`))
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

  // ── Terminal UI ──────────────────────────────────────────────────
  //
  // ANSI colors (no dependencies). Minimal, color-coded output:
  //   dim     — system info (prefetch, turn stats)
  //   cyan    — tool names
  //   yellow  — tool queries/args
  //   red     — errors
  //   default — model response text

  const isTTY = process.stdout.isTTY
  const c = {
    dim:     (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
    cyan:    (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
    yellow:  (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
    red:     (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
    green:   (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
    bold:    (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  }

  let sessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let turnCount = 0
  let currentToolCalls: { name: string; id: string; args: string }[] = []

  // Timing
  let promptStartTime = 0       // when user hits enter
  let turnStartTime = 0         // when a turn begins
  let firstTokenTime = 0        // first text_delta of synthesis
  let firstTokenEmitted = false  // track per prompt

  const elapsed = (from: number) => {
    const ms = Date.now() - from
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
  }

  agent.on((event) => {
    switch (event.type) {
      case 'agent_start':
        promptStartTime = Date.now()
        firstTokenEmitted = false
        break

      case 'prefetch_start':
        break
      case 'prefetch_end':
        break

      case 'tool_call_start': {
        const query = (event.args.query as string) || (event.args.path as string) || ''
        const preview = query.slice(0, 80)
        currentToolCalls.push({ name: event.name, id: event.id, args: preview })
        break
      }
      case 'tool_call_end': {
        const tokens = Math.ceil(event.result.content.length / 3.5)
        const call = currentToolCalls.find(t => t.id === event.id)
        if (event.result.isError) {
          process.stderr.write(c.red(`  ✗ ${event.name}: ${event.result.content.slice(0, 80)}\n`))
        } else {
          process.stderr.write(
            `  ${c.cyan(event.name)} ${c.yellow(call?.args || '')}` +
            c.dim(` → ${tokens} tokens\n`),
          )
        }
        break
      }

      case 'turn_start':
        turnStartTime = Date.now()
        break

      case 'turn_end':
        turnCount++
        currentToolCalls = []
        if (event.usage) {
          sessionTokens.input += event.usage.inputTokens
          sessionTokens.output += event.usage.outputTokens
          sessionTokens.cacheRead += event.usage.cacheReadTokens || 0
          sessionTokens.cacheWrite += event.usage.cacheWriteTokens || 0
          const cached = event.usage.cacheReadTokens || 0
          const turnTime = elapsed(turnStartTime)
          process.stderr.write(c.dim(
            `  ─ turn ${turnCount}: ${event.usage.inputTokens} in → ${event.usage.outputTokens} out` +
            (cached > 0 ? ` (${cached} cached)` : '') +
            ` ${turnTime}\n`,
          ))
        }
        break

      case 'text_delta':
        if (!firstTokenEmitted) {
          firstTokenEmitted = true
          firstTokenTime = Date.now()
          process.stderr.write(c.green(`  ⚡ first token: ${elapsed(promptStartTime)}\n`))
        }
        process.stdout.write(event.text)
        break

      case 'compact_start':
        process.stderr.write(c.dim('  ◇ compacting context...\n'))
        break
      case 'compact_end':
        process.stderr.write(c.dim('  ◇ compacted\n'))
        break

      case 'error':
        process.stderr.write(c.red(`\n  ✗ ${event.error}\n`))
        break

      case 'agent_end': {
        const totalIn = sessionTokens.input + sessionTokens.cacheRead + sessionTokens.cacheWrite
        const totalTime = elapsed(promptStartTime)
        process.stderr.write(c.dim(
          `  ═ ${totalIn} in, ${sessionTokens.output} out` +
          (sessionTokens.cacheRead > 0 ? ` (${sessionTokens.cacheRead} cached)` : '') +
          ` · ${totalTime}\n`,
        ))
        process.stdout.write('\n')
        break
      }
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

  process.stderr.write('\n')
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[32m❯\x1b[0m ',
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
