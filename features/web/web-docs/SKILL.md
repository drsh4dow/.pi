---
name: web-docs
description: About to rely on a library API whose behavior may differ by version, or a library question needs its docs, types or changelog at the version this project uses.
---

# Docs at the right version

Find the version first, then read the most exact source that exists. Stop at the first step that answers.

1. **Find the version in use.** Read the lockfile or manifest: `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`, `go.mod`, `uv.lock`, `requirements*.txt`. For an installed JS package, `node_modules/<pkg>/package.json` is the truth.
2. **Read the installed source.** It is the exact version and costs nothing. Look in `node_modules/<pkg>/` for `README.md`, `docs/`, `*.d.ts`, and `CHANGELOG.md`. Search it with `rg`. Types and source beat prose docs when they disagree.
3. **Read the repo at the version's tag.** `web_fetch("https://github.com/<owner>/<repo>/tree/<tag>/docs")` lists the docs folder at that tag. Each entry is a URL you can `web_fetch`. Find the tag name with `git ls-remote --tags https://github.com/<owner>/<repo> | rg <version>`. To search a whole repo, clone it: `git clone --depth 1 --branch <tag> https://github.com/<owner>/<repo> "${XDG_CACHE_HOME:-$HOME/.cache}/pi-web/$(date -u +%F)/<repo>@<tag>"`, then `rg` inside it. Date folders are deleted after 7 days.
4. **Read the official docs site.** `web_fetch` the page. It already asks for markdown and tries the `.md` copy many docs sites publish. Check the page names the version you use. Docs sites usually show only the latest version, so a newer page is a lead, not an answer.
5. **Search.** `web_search` with `domains` set to the official docs host, then step 4 on what it finds.

Never take a docs-aggregator page (Context7 and similar) as the answer. Their copies are unversioned and have carried injected instructions.

Say which step answered and the version it was for.
