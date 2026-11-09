# pi harness

My own coding harness, built on [pi](https://github.com/earendil-works/pi). This folder is also pi's live config dir (`~/.pi`), so `.gitignore` is an allowlist: credentials (`agent/auth.json`) and session history (`agent/sessions/`) must never be committed.

## Rules

- Run `bun run check` before every commit. It must exit clean.
- Use bun as the package manager. `bun install` runs `effect-tsgo patch --oxlint`, which swaps the TypeScript, oxlint, and tsgolint binaries for Effect's builds.
- Fix the code, never the gate. Don't disable or downgrade lint rules, and don't add `oxlint-disable` or `@ts-expect-error` to get green.
- Relative imports end in `.ts`. Use only erasable TypeScript syntax: no `enum`, `namespace`, or parameter properties.
- Top-level imports only. No `await import()` or `import("pkg").Type`.
- An extension with its own `package.json` lists the packages pi supplies at runtime (`@earendil-works/pi-*`, `typebox`) in `peerDependencies` with `"*"`, never `dependencies`.
- When an Effect or pi convention conflicts with a lint rule, the Effect or pi convention wins. Turn the rule off in `.oxlintrc.jsonc` with a one-line reason, and add the idiom to `tools/oxlint/fixtures/effect-pi-idioms.ts`.
- After changing `SYSTEM.md`, a role file, a principle, an extension's prompt guidelines, or an instructions file in `agent/instructions/`, run `bun run prompts [project-dir]`. It writes `system-prompts.md` (gitignored): the full system prompt stock pi, the root, a level-2 delegate on each instructions file, and a bare delegate at the last level get.
- `tools/oxlint/anti-slop/` is vendored. Update it with the `install-anti-slop` skill and record changes in its `UPSTREAM.md`.
- The code inside skills (`making-videos/scripts/` and `templates/`, `writing-good-prs/scripts/`, `dumpfile/cli/`) is vendored: oxfmt, oxlint and tsc skip it, and `bun test` still runs its tests.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
