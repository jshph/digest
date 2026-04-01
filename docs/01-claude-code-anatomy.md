# Claude Code Anatomy: What's Inside 512K Lines of Code

## The Size Problem

- **512,685 lines** across **1,902 files** (TypeScript/TSX)
- Breakdown by module size:
  - `components/` — 9.9MB (UI components, React Ink TUI)
  - `utils/` — 7.6MB (utilities, the real grab bag)
  - `tools/` — 3.0MB (tool definitions + UI)
  - `commands/` — 2.9MB (CLI commands)
  - `services/` — 2.0MB (analytics, MCP, compaction, API)
  - `hooks/` — 1.4MB (React hooks for TUI state)
  - `ink/` — 1.2MB (custom React Ink rendering engine)
  - `screens/` — 1.0MB (REPL screen, settings, etc.)
  - `bridge/` — 532K (IDE integration bridge)
  - `cli/` — 524K (CLI output formatting)
  - Everything else — ~2MB total

## What a Writing Agent Does NOT Need (>80% of the codebase)

### TUI/UI Layer (~15MB, ~60% of codebase)
- `components/` — React Ink components (status line, log selector, stats, etc.)
- `ink/` — Custom React Ink rendering engine (dom, render-node-to-output, selection, styles)
- `screens/` — REPL screen (5005 lines), settings screens
- `hooks/` — React hooks (useTypeahead 1384 lines, useVoice 1144 lines, etc.)
- `keybindings/` — vim mode, keyboard shortcuts
- `vim/` — full vim emulation
- `voice/` — voice input/output

### IDE Integration (~600K)
- `bridge/` — VS Code/JetBrains integration (bridgeMain 2999 lines, replBridge 2406 lines)

### Code-Specific Tools (~2MB)
- Most of `tools/` — FileEditTool, BashTool, GlobTool, GrepTool, LSPTool, NotebookEditTool, WorktreeTool
- Git-specific: worktree management (1519 lines), git utilities

### Enterprise/Analytics/Auth (~1MB)
- `services/analytics/` — Statsig, GrowthBook, telemetry
- `utils/auth.ts` (2002 lines)
- `utils/config.ts` (1817 lines)
- Feature flags throughout (`feature('PROACTIVE')`, `feature('KAIROS')`, etc.)

## What IS Worth Borrowing

### 1. System Prompt Architecture (`constants/prompts.ts` — 915 lines)
The system prompt is built from composable sections:
- **Static prefix** (cacheable across orgs): intro, system rules, doing tasks, actions, tool usage, tone
- **Dynamic boundary marker**: `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
- **Dynamic suffix** (per-session): env info, language, output style, MCP instructions, memory

Key insight: They split system prompt into **cacheable** vs **dynamic** parts to maximize prompt caching. The boundary marker is critical — everything before it gets `scope: 'global'` caching.

Token budget of system prompt (rough estimates):
- Base system instructions: ~3,000 tokens
- Tool definitions (all 20+ tools): ~5,000-8,000 tokens
- CLAUDE.md injection: variable (up to 25KB / ~6,000 tokens)
- Git status injection: ~500 tokens
- Environment info: ~300 tokens
- **Total base overhead: ~10,000-15,000 tokens before any user content**

### 2. Context Compression System (`services/compact/`)
This is the crown jewel for small-context-window agents:

- **Auto-compact**: Triggers when token usage exceeds `contextWindow - 13,000` tokens
- **Compaction prompt**: Asks the model to produce a structured summary with:
  1. Primary request and intent
  2. Key technical concepts
  3. Files and code sections (with snippets)
  4. Errors and fixes
  5. Problem solving
  6. All user messages (verbatim)
  7. Pending tasks
  8. Current work
  9. Optional next step
- **Analysis scratchpad**: Uses `<analysis>` tags for drafting that get stripped from final summary
- **Partial compaction**: Can compact only older messages while keeping recent ones intact
- **Post-compaction message**: Frames the summary as "continuing from a previous conversation"
- **MicroCompact**: More aggressive compaction for tool results (clears old results, keeps N most recent)

### 3. Skills System (`skills/`)
- Skills = markdown files with YAML frontmatter
- Frontmatter fields: `name`, `description`, `whenToUse`, `allowedTools`, `model`, `context` (inline|fork), `agent`
- Skills are lazy-loaded: only frontmatter tokens counted upfront, full content loaded on invocation
- Token estimation: `estimateSkillFrontmatterTokens()` counts only name+description+whenToUse
- Can be loaded from: user dir (`~/.claude/skills/`), project dir (`.claude/skills/`), bundled, MCP, plugin

### 4. Memory System (`memdir/`)
- Entry point: `MEMORY.md` (max 200 lines / 25KB)
- Auto-memory directory: `~/.claude/projects/<hash>/memory/`
- Truncation: line-based + byte-based caps
- Memory types: patterns, preferences, solutions, architecture
- Memory prompt injected into system context every turn

### 5. Hooks System (`utils/hooks.ts` — 5022 lines)
- Events: pre/post tool call, pre/post compact, session start, prompt submit
- Hooks = shell commands configured in settings.json
- Hook results appear as `<user-prompt-submit-hook>` tags in messages
- Pre-compact and post-compact hooks for custom compaction behavior

### 6. MicroCompact / Function Result Clearing
- Old tool results cleared from context automatically
- Keeps N most recent results
- System prompt tells model to "write down important info" before results are cleared
- `SUMMARIZE_TOOL_RESULTS_SECTION`: "When working with tool results, write down any important information you might need later"

## Prompt Coercion Analysis

The system prompt is **heavily oriented toward code editing**. Sections that would be unnecessary for a writing agent:

1. **"Doing tasks" section** (~800 tokens): Entirely about software engineering — "The user will primarily request you to perform software engineering tasks"
2. **"Using your tools" section** (~600 tokens): Dedicated tool routing rules (use Read not cat, use Edit not sed)
3. **"Executing actions with care" section** (~500 tokens): Git-specific safety (force push, reset --hard, etc.)
4. **Tool definitions** (~5,000-8,000 tokens): 20+ tools, each with detailed schemas and descriptions
5. **Git status** (~500 tokens): Branch info, recent commits, status
6. **Code style instructions**: Don't add docstrings, avoid over-engineering, etc.
7. **Security warnings**: OWASP top 10, command injection, XSS

**For a writing agent, you could cut the system prompt from ~15K tokens to ~2-3K tokens** by:
- Removing all code-editing instructions
- Removing git/security/IDE sections
- Keeping only: identity, memory, environment, output style, tool routing (for 3-4 tools max)
- Keeping: compaction prompt (adapted for writing context)

## Architecture Patterns Worth Adopting

1. **Cacheable/dynamic prompt split** — essential for API cost efficiency
2. **Auto-compact with structured summary** — essential for small context windows
3. **Lazy skill loading** — only load skill content when invoked
4. **Memory entry point with size caps** — keeps memory from bloating context
5. **Tool result clearing** — proactively remove old results from context
6. **Partial compaction** — keep recent messages, summarize older ones
7. **Prompt sections as functions** — compose system prompt from independent sections
