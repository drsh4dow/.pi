# Pi

Opinionated config for [Pi](https://github.com/mariozechner/pi). Strong model, small harness, strict workflow.

- Engine: `openai-codex/gpt-5.5`, high thinking.
- Taste: *suckless*, *A Philosophy of Software Design*, *The Pragmatic Programmer*.
- Human owns direction. Agent owns evidence.

Behavior contract: [`agent/SYSTEM.md`](agent/SYSTEM.md).

## Install

```bash
git clone https://github.com/drsh4dow/.pi ~/.pi
bun add -g @mariozechner/pi-coding-agent   # or: npm i -g @mariozechner/pi-coding-agent
pi install npm:pi-questions
pi install npm:pi-delegate
```

## Loop

1. `/do-plan <task>` — read-only. Explores, researches, interviews, emits a plan.
2. Approve or revise. In case you want to deepen the plan run `/skill:grill-with-docs`
3. `/do-work proceed with the plan` — small slices, each verified before claiming done.
4. Review diff + evidence. Commit only on accept.

## Prompts ([`agent/prompts/`](agent/prompts))

We use prompts for deterministic triggers. Skills are injected into the context, so it
makes sense for things that must be triggered automatically. But for
deterministic things, it makes a lot more sense to use prompts.

## Extensions

- `pi-questions` — `ask_questions` TUI.
- `pi-delegate` — `delegate` to isolated child sessions. The only subagent primitive.
- `pi-web-minimal` — web, code, docs, URL, and GitHub retrieval.

## Web search setup

`pi-web-minimal` reads `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "...",
  "context7ApiKey": "..."
}
```

Environment alternatives:

- `EXA_API_KEY`
- `CONTEXT7_API_KEY`

Tools exposed: `web_search`, `code_search`, `documentation_search`, `fetch_content`, `get_search_content`.
