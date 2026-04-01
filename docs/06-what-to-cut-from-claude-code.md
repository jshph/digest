# Prompt Coercion Audit: What to Cut

Every line of system prompt is a line the user can't use. Here's a detailed breakdown of Claude Code's system prompt sections and what a writing agent should do with each.

## Section-by-Section Analysis

### 1. Identity / Intro (~200 tokens)
```
You are Claude Code, Anthropic's official CLI for Claude.
You are an interactive agent that helps users with software engineering tasks.
```
**Cut entirely.** Replace with ~50 tokens of writing-focused identity.

### 2. Security Instructions (~150 tokens)
```
IMPORTANT: Assist with authorized security testing...
IMPORTANT: You must NEVER generate or guess URLs...
```
**Cut entirely.** A writing agent doesn't need security testing guidance or URL generation warnings.

### 3. System Section (~400 tokens)
- "All text you output outside of tool use is displayed to the user" — **Keep** (10 tokens)
- Tool permission mode explanation — **Keep** (30 tokens, simplified)
- System-reminder tag explanation — **Cut** (not needed without system reminders)
- Prompt injection warning — **Keep** (20 tokens, simplified)
- Hooks explanation — **Keep if hooks exist** (20 tokens)
- "The system will automatically compress prior messages" — **Keep** (15 tokens)

### 4. Doing Tasks Section (~800 tokens)
```
The user will primarily request you to perform software engineering tasks...
```
**Cut ALL of this.** It's entirely about:
- Software engineering task framing
- Code modification rules (read before editing, don't create unnecessary files)
- Time estimate avoidance
- Retry/blocking strategies
- OWASP security warnings
- Over-engineering avoidance (code-specific: "don't add docstrings", "don't add error handling for impossible scenarios")
- Backwards-compatibility hacks warning
- Help/feedback info

Replace with ~100 tokens of writing-focused task framing.

### 5. Executing Actions with Care (~500 tokens)
```
Carefully consider the reversibility and blast radius of actions...
```
Detailed git safety rules, destructive operation warnings, merge conflict guidance.
**Cut almost entirely.** A writing agent just needs: "Don't overwrite files without reading them first. If unsure, ask." (~20 tokens)

### 6. Using Your Tools Section (~600 tokens)
```
Do NOT use Bash to run commands when a relevant dedicated tool is provided...
```
Detailed routing: use Read not cat, use Edit not sed, use Glob not find, etc.
**Cut and replace.** With 4-5 tools, routing is simple. ~50 tokens.

### 7. Agent Tool Section (~200 tokens)
Subagent guidance (when to use Explore agent, avoid duplicating work).
**Cut entirely.** No subagents in the writing agent.

### 8. Session-Specific Guidance (~300 tokens)
Skill usage, AskUser guidance, explore/plan agents.
**Simplify to ~30 tokens** about available skills if any.

### 9. Tone and Style (~150 tokens)
- No emojis — **Keep** (10 tokens)
- Be concise — **Keep** (10 tokens)
- File path:line_number references — **Cut** (code-specific)
- GitHub issue format — **Cut** (code-specific)
- No colon before tool calls — **Keep** (15 tokens)

### 10. Output Efficiency (~300 tokens)
```
IMPORTANT: Go straight to the point. Try the simplest approach first...
```
**Keep and adapt** (~100 tokens). Good general guidance for any agent.

### 11. Memory Section (~300 tokens)
Auto memory directory, how to save, what to save, what not to save.
**Keep and simplify** (~150 tokens). Memory is useful for writing context.

### 12. Environment Section (~300 tokens)
Working directory, platform, shell, OS, model info, model family IDs, Claude Code availability, fast mode.
**Simplify to ~50 tokens**: vault path, date, model name.

### 13. Git Status (~500 tokens)
Branch, main branch, git user, status, recent commits.
**Cut entirely.** No git context needed.

### 14. Function Result Clearing (~100 tokens)
"Old tool results will be automatically cleared from context."
**Keep** (~30 tokens).

### 15. Summarize Tool Results (~30 tokens)
"Write down any important information you might need later."
**Keep as-is** (30 tokens). Critical for small context.

## Total Token Savings

| Category | Claude Code | Scribe | Savings |
|----------|-----------|--------|---------|
| Identity/security | 350 | 50 | -300 |
| System rules | 400 | 75 | -325 |
| Task framing | 800 | 100 | -700 |
| Safety/actions | 500 | 20 | -480 |
| Tool routing | 600 | 50 | -550 |
| Agent/subagent | 200 | 0 | -200 |
| Session guidance | 300 | 30 | -270 |
| Tone/style | 150 | 35 | -115 |
| Output efficiency | 300 | 100 | -200 |
| Memory | 300 | 150 | -150 |
| Environment | 300 | 50 | -250 |
| Git/code-specific | 600 | 0 | -600 |
| Context mgmt | 130 | 60 | -70 |
| **System prompt total** | **~4,930** | **~720** | **-4,210 (85% reduction)** |
| **Tool definitions** | **~6,000** | **~1,100** | **-4,900 (82% reduction)** |
| **Total overhead** | **~11,000** | **~1,820** | **-9,180 (83% reduction)** |

## The Dynamic Overhead Problem

Claude Code's dynamic injections per turn also consume tokens:

| Injection | Claude Code | Scribe |
|-----------|-----------|--------|
| CLAUDE.md / user instructions | 0-6,000 | 0-500 (smaller config) |
| Skill frontmatter listings | 0-2,000 | 0-200 |
| System reminders | ~200/turn | 0 |
| MCP instructions | 0-1,000 | 0 |

**Key decision**: Don't inject skill listings into every turn. Only inject when the user invokes one or asks about capabilities.
