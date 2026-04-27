# Pi Setup

Opinionated Pi setup for senior developers who want agentic coding with engineering quality first.

The protagonist is [`agent/SYSTEM.md`](agent/SYSTEM.md): inspect before editing, prefer simple/deep modules, push back on bad tradeoffs, preserve context, and verify before claiming success.

## Install

```bash
git clone https://github.com/drsh4dow/.pi ~/.pi
# bun or npm
bun add -g @mariozechner/pi-coding-agent
pi install npm:pi-web-access
pi install npm:pi-questions
pi install npm:pi-delegate
```

## Core Bet

Strong model. Small harness. Strict workflow.

- Default engine: `openai-codex/gpt-5.5`, high thinking.
- Goal: better software, not more automation theater.
- Simplicity is a tool, not an aesthetic.
- Human approves direction; agent executes with evidence.

## Workflow

Use this loop by default:

1. `/do-plan <task>`
2. Approve or revise the plan
3. `/do-work implement the plan`
4. Review diff + verification evidence
5. Commit only after human acceptance

`/do-plan` is read-only. It gathers repo context, researches current docs when needed, asks structured questions, resolves the design tree, and outputs a short plan plus validation.

`/do-work` executes. It reads the plan, reuses existing code, works in small slices, validates each slice, loads `verification-before-completion`, and reports evidence instead of confidence.

## Packages

Configured in [`agent/settings.json`](agent/settings.json):

- `pi-web-access`: web search, URL/GitHub/PDF/video extraction.
- `pi-questions`: minimal `ask_questions` TUI for structured user decisions.
- `pi-delegate`: minimal `delegate` tool for isolated child Pi sessions (subagents).

`delegate` is the subagent primitive. Roles like scout, reviewer, or breaker are delegated work patterns, not a workflow engine.

## Files That Matter

- [`agent/SYSTEM.md`](agent/SYSTEM.md): behavior contract.
- [`agent/settings.json`](agent/settings.json): live Pi config; copy policy, not local state.
- [`agent/prompts/do-plan.md`](agent/prompts/do-plan.md): planning gate.
- [`agent/prompts/do-work.md`](agent/prompts/do-work.md): execution loop.
- [`agent/prompts/grill-me.md`](agent/prompts/grill-me.md): relentless interview pattern.
- [`agent/prompts/improve-codebase-architecture.md`](agent/prompts/improve-codebase-architecture.md): deep-module architecture vocabulary.
- [`agent/skills/verification-before-completion/SKILL.md`](agent/skills/verification-before-completion/SKILL.md): evidence before claims.
- [`agent/skills/context7/SKILL.md`](agent/skills/context7/SKILL.md): current library docs.
- [`agent/skills/agent-browser/SKILL.md`](agent/skills/agent-browser/SKILL.md): browser/Electron automation.

Private/runtime state is ignored: auth, sessions, run history, search config, caches, env files. Those will get populated with your own data.
