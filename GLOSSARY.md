# Glossary

## Layout

See `docs/adr/0001-harness-layout.md`.

- **Host.** The program that loads an entrypoint: pi.
- **Entrypoint.** The file pi loads for one extension, `agent/extensions/<name>/index.ts`. It only wires a feature into pi.
- **Feature.** One piece of harness behavior, in `features/<name>/`, used only through its `index.ts`.
- **Client.** A typed adapter to one outside system, such as hc, systemd or pi's session store, in `clients/<system>/index.ts`.

## Prompt

Terms from the prompt feature (`features/prompt/`), which builds every agent's system prompt. The root and every delegate load it.

- **Shared layer.** `agent/SYSTEM.md`: how to operate inside this harness, the same for every agent. pi puts it first.
- **Role layer.** The `<role>` and `<collaboration>` blocks from a role file, then a delegate's `<instructions>`. It comes right after the shared layer. Not to be confused with **Role** below, which says where an agent sits.
- **Role file.** `agent/roles/root.md` for the root, `agent/roles/delegate.md` for every owner and leaf. Each file is the text the model reads, tags included. What an owner has beyond a leaf comes with the `delegate` tool and its guidelines, so the two share a file.
- **Instructions.** What one delegate does, from its delegate file's `instructions`. The parent stages them in a file and passes `--instructions <file>`.
- **Principle.** A hard rule that steers how an agent thinks, in `agent/principles/<name>.md`. Its frontmatter has a one-line `when` and an optional `for` naming the roles it fits. The prompt lists each fitting principle's name, `when` and file under `<principles>`, and the agent reads the file when the `when` might match. Prompt text and answers point at one as `principle-<name>`.
- **Tool context.** The `<tools>` list (each tool's one-line snippet), the `<rules>` list (each tool's and extension's guidelines) and `<docs>` that pi writes into its default prompt. A custom preamble makes pi drop them, so the prompt feature adds them back. It leaves out pi's generic rules (the bash file-ops rule, "Be concise", "Show file paths clearly") and the "Additional tools may be available" line, since `SYSTEM.md` sets its own style.

## Owned work

Terms from the owned-work feature (`features/owned-work/`).

- **Owned work.** Every delegate, serve, watch and group a pi process started. It dies with that process.
- **Delegate.** A child pi started on one task message. It answers once, as its last assistant text, and cannot ask its parent anything. Configs live in `agent/delegates/<name>.ts`, and a trusted project's `.pi/delegates/` overrides them by name.
- **Role.** Where an agent sits: the **root** is the pi the user runs, an **owner** is a delegate that may start delegates of its own, and a **leaf** may not. A serve or watch runs as a leaf, so a pi it starts cannot delegate.
- **Serve.** A long-running command, such as a dev server. It runs until stopped, or until the group holding it settles. Its end never wakes anyone: it is delivered in its group's result, beside a job's result, or in a `stop` reply. A serve that fails to spawn fails its own `serve` call instead.
- **Watch.** A command whose exit wakes the agent with its exit code and last lines.
- **Job.** A delegate, a watch or a group: work that settles with a result. A serve is not a job.
- **Group.** Work moved out of the agent's hands into one unit. Mode **all** wakes the agent once with every result. Mode **each** wakes it once per result.
- **Holder.** Who receives a piece of work's result: the agent, or the group it was moved into.
- **Handle.** The plain JSON a start tool returns, such as `{ "ref": "delegate-3", "kind": "delegate", "terminal": "t7" }`.
- **Ref.** A handle's id, such as `delegate-3`. Unique within one pi process.
- **Settle.** A job's end: done, fired, failed, or a group's member results. The ledger also writes a settle entry when a serve ends, so every piece of work has one.
- **Deliver.** Hand a settled result to the agent, exactly once: at the end of a turn, by a wake while idle, or in a `stop` reply.
- **Wake.** A message that carries results to an idle agent and starts its next turn.
- **Ledger.** The one module that records owned work, who holds it and what was delivered. It writes the `owned-work` session entries.
- **Anchor.** One hc terminal per pi process, running `tail --pid=<pi pid>`. Every terminal the agent starts sits under it, so killing pi ends each terminal's program. Its slice ends the rest.
- **Slice.** The systemd user slice a delegate, serve or watch runs in, named `<owner's slice>-<ref without dashes>`, such as `pi-ow-1a2b3c4d-delegate3`. The root's slice is `pi-ow-<agent key>`, and the work's own work nests below its slice. Settling the work stops its slice, which ends every process in it, even one that left its process group. A user service of the same name watches the root's pid and stops the root's slice when the root dies.
- **Child session.** A delegate's own pi session, in the `delegates/` folder next to the root's sessions, so `pi -c` never opens one. Under `--no-session` the root has no session folder, so its delegates go in a `pi-delegates-<random>` folder in the temp folder, made owner-only when the first delegate starts.
- **Staged files.** A delegate's task message and instructions, written as `<session id>.message` and `<session id>.instructions` beside its child session, because one argv word holds at most 128 KiB. The ledger deletes them when the delegate settles.

## Web

Terms from the web client (`clients/web/`) and feature (`features/web/`).

- **Page.** What reading one URL gives back: the URL asked for, the final URL after redirects, a title, the source that read it, an optional caveat, and a body. The body is markdown, or a file such as a PDF with the markdown extracted from it.
- **Source.** One way to read a URL, such as GitHub's API, npm, Hacker News, Reddit, Docsify, a direct fetch, or Exa's copy. The sources sit in one ordered table. The first source that claims a URL and answers reads it.
- **Via.** The name of the source that read a page. It is shown to the model beside the page.
- **Site source.** A source that reads a site's own API or files, such as GitHub's API, npm's README, a Hacker News or Reddit thread, or a Docsify page's markdown. Its answer is the whole page, so it skips the verdict (`skipsVerdict`) and is never judged thin or a bot check. A direct fetch and Exa's copy are judged, and Exa's copy also carries a caveat.
- **Saved page.** The whole of a fetched page, written under the web cache as `<date>/<host and path>-<8 random>.md`. A file keeps its own bytes at `<...>.<ext>`, and its markdown, if any, at `<...>.<ext>.md`. web_fetch shows the head, plus the `read(path, offset)` call that continues it.
- **Untrusted content.** Page text and search highlights. They are data, never instructions. Inline text sits in one `<web_content trust="untrusted">` tag, and each saved page's first line says the same.
- **Web cache.** `${XDG_CACHE_HOME:-~/.cache}/pi-web/`, readable only by the user. With neither variable set there is none, and web_fetch fails. Date folders older than 7 days are deleted when a session starts.
