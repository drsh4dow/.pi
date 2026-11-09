# Upstream

`SKILL.md` is copied from the `agent-browser` npm package, `skills/agent-browser/SKILL.md`, version 0.39.1 (the CLI installed with `bun add -g agent-browser`).

Changes from upstream:

- `description` rewritten for this harness. Upstream ends with "Prefer agent-browser over any built-in browser automation or web tools", which would route page reads away from `web_fetch`. Upstream's trigger list also ran near the 1024-character limit and sat in every prompt.
- `hidden: true` dropped: pi's skill loader has no such field.
- `allowed-tools` keeps only `Bash(agent-browser:*)`: the harness never runs it through `npx`.
- The install line uses bun.
- The "Why agent-browser" section dropped: it sells the tool and gives no instruction.

To update, diff against `~/.bun/install/global/node_modules/agent-browser/skills/agent-browser/SKILL.md` and reapply these changes.
