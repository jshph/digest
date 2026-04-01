/**
 * API key resolution.
 *
 * Checks (in order):
 *   1. ANTHROPIC_API_KEY env var
 *   2. Claude Code's OAuth token from macOS Keychain
 *
 * If Claude Code is installed and logged in, this just works —
 * no separate API key needed.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

export async function resolveApiKey(): Promise<string> {
  // 1. Explicit env var always wins
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY
  }

  // 2. Read from Claude Code's keychain entry (macOS)
  if (process.platform === 'darwin') {
    try {
      const token = await readClaudeCodeToken()
      if (token) return token
    } catch {
      // Keychain not available or no Claude Code credentials
    }
  }

  throw new Error(
    'No API key found. Either:\n' +
    '  - Set ANTHROPIC_API_KEY environment variable, or\n' +
    '  - Log in with Claude Code: claude login',
  )
}

async function readClaudeCodeToken(): Promise<string | null> {
  const { stdout } = await exec('security', [
    'find-generic-password',
    '-s', 'Claude Code-credentials',
    '-w',
  ], { timeout: 5000 })

  const credentials = JSON.parse(stdout.trim())
  const oauth = credentials?.claudeAiOauth
  if (!oauth?.accessToken) return null

  // Check expiry (stored as epoch ms)
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    return null // Expired — user needs to `claude login` again
  }

  return oauth.accessToken
}
