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
pi install npm:pi-questions npm:pi-delegate npm:pi-web-minimal npm:pi-telemetry-minimal
```

## Loop

1. `/do-plan <task>` — read-only. Explores, researches, interviews, emits a plan.
2. Approve or revise.
3. `/do-work` — small slices, each verified before claiming done.
4. Review diff + evidence. Commit only on accept.

## Prompts ([`agent/prompts/`](agent/prompts))

We use prompts, not skills. Skills are injected into the context, so it
makes sense for things that must be triggered automatically. But for
deterministic things, it makes a lot more sense to use prompts.

`do-plan` · `do-work` · `grill-me` · `improve-codebase-architecture` · `write-prd` · `prd-to-issues` · `write-skill`

## Skills ([`agent/skills/`](agent/skills))

`verification-before-completion` · `agent-browser` · `frontend-design`

## Extensions

- `pi-questions` — `ask_questions` TUI.
- `pi-delegate` — `delegate` to isolated child sessions. The only subagent primitive.
- `pi-web-minimal` — web, code, docs, URL, and GitHub retrieval.
- `pi-telemetry-minimal` — local JSONL telemetry, with optional webhook export.

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

## Telemetry setup

`pi-telemetry-minimal` reads `~/.pi/telemetry-minimal.json`:

```json
{
    "webhook": {
      "url": "https://telemetry.example.com/api/telemetry/events",
      "token": "pi-telemetry-web-ingest-token",
      "timeoutMs": 2000
    }
  }
}
```

Runtime state and local secrets (`auth.json`, `sessions/`, `run-history.jsonl`,
`web-search.json`, `telemetry-minimal.json`, `telemetry-minimal/`, caches, `.env`)
are gitignored and will be populated with your data by running the agent.
