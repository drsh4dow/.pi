# Pi

Opinionated config for [Pi](https://github.com/mariozechner/pi). Strong model, small harness, strict workflow.

- Engine: `openai-codex/gpt-5.5`, high thinking.
- Taste: *suckless*, *A Philosophy of Software Design*, *The Pragmatic Programmer*.
- Human owns direction. Agent owns evidence.

Behavior contract: [`agent/SYSTEM.md`](agent/SYSTEM.md).

## Install

```bash
git clone https://github.com/drsh4dow/.pi ~/.pi
bun add -g @mariozechner/pi-coding-agent   # or: npm i -g
pi install npm:pi-web-access npm:pi-questions npm:pi-delegate
```

## Loop

1. `/do-plan <task>` — read-only. Explores, researches, interviews, emits a plan.
2. Approve or revise.
3. `/do-work` — small slices, each verified before claiming done.
4. Review diff + evidence. Commit only on accept.

`/grill-me` for stress-testing a design first. The concepts behind
the `/grill-me` prompt applied in /do-plan, so this prompt is useful only
when there is still doubts in the plan on both sides.

## Prompts ([`agent/prompts/`](agent/prompts))

We use prompts, not skills. Skills are injected into the context, so it
makes sense for things that must be triggered automatically. But for
deterministic things, it makes a lot more sense to use prompts.

`do-plan` · `do-work` · `grill-me` · `improve-codebase-architecture` · `write-prd` · `prd-to-issues` · `write-skill`

## Skills ([`agent/skills/`](agent/skills))

`verification-before-completion` · `context7` · `agent-browser`

## Packages

- `pi-web-access` — search + URL/GitHub/PDF/video extraction.
- `pi-questions` — `ask_questions` TUI.
- `pi-delegate` — `delegate` to isolated child sessions. The only subagent primitive.

Runtime state (`auth.json`, `sessions/`, `run-history.jsonl`, caches, `.env`)
is gitignored and those will get populated with your data by running the agent.
