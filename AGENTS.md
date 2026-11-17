# pi harness

Next-gen coding harness, built on pi + Herdr-Core. This folder is also pi's live config dir (`~/.pi`), so `.gitignore` is an allowlist: credentials (`agent/auth.json`) and session history (`agent/sessions/`) must never be committed.

Run `bun run check` before every commit. It must exit 0.

Read `CODING_STANDARDS.md` before you write code, change a gate's config, or change the harness's prompts.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
