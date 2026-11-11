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
- **Role layer.** The `<role>` and `<collaboration>` blocks from a role file, then a delegate's `<instructions>`. It comes right after the shared layer. Not to be confused with an agent's **role** under **Level** below.
- **Role file.** `agent/roles/<role>.md`: `root.md` for the root, `delegate.md` for a delegate at any level. Each file is the text the model reads, tags included. What sets one level apart comes with the `delegate` tool and its guidelines, so every delegate shares a file.
- **Instructions.** What one delegate does, from the body of the file its parent named in the `delegate` call's `instructionsFile`, such as `agent/instructions/cold-reader.md`, or a prompt file inside a skill. The parent reads the file at the call, stages a copy of the body, and passes `--instructions <copy>`, so a later edit never reaches a running child. The file's frontmatter is its **profile**, under Owned work below.
- **Principle.** A hard rule that steers how an agent thinks, in `agent/principles/<name>.md`. Its frontmatter has a one-line `when` and an optional `for` naming the roles it fits. The prompt names the principles folder once in `<principles dir="…">`, then lists each fitting principle as `name: when`, and the agent reads `<name>.md` when the `when` might match. A skill, a role file, or an answer points at one as `principle-<name>`. A principle stands alone: it names no other principle, and the agent reaches it only through its own `when`.
- **Skills section.** The `<skills>` section the prompt feature writes in pi's place: the skills rule, then each skill the role may invoke as `name: description`, in one list per folder that names the folder once. A skill's `for` names its roles, as a principle's does; without it, every role. A hidden skill also leaves pi's own list.
- **Tool context.** The `<tools>` list (each tool's one-line snippet), the `<rules>` list (each tool's and extension's guidelines) and `<docs>` that pi writes into its default prompt. A custom preamble makes pi drop them, so the prompt feature adds them back. It leaves out pi's generic rules (the bash file-ops rule, "Be concise", "Show file paths clearly"), the guidelines of `edit` and `codemode`, which restate their schema and `<codemode>`, and the "Additional tools may be available" line, since `SYSTEM.md` sets its own style.

## Owned work

Terms from the owned-work feature (`features/owned-work/`).

- **Owned work.** Every delegate, serve, watch and group a pi process started. It survives a reload, and stops when the process quits or leaves its session: `/new`, `/resume`, or a fork outside herdr-app. See ADR 0002.
- **Handover.** What a reload passes from one load of the owned-work extension to the next in the same process: the ledger's state and the agent key, so the work keeps running. A reload that changed the ledger's own types refuses it and stops the work.
- **Agent key.** Eight characters that name one pi's terminals in hc (`ow.agent`) and its slice. A reload keeps it, and any other session start picks a new one.
- **Fork tab.** Where `/fork` and `/clone` put the copy in a herdr-app tab: a new pi in a new tab of the same space, focused, while the source tab keeps its session and its work. The copy notes which work kept running in the source.
- **Delegate.** A child pi the `delegate` tool starts on one task message. It answers once, as its last assistant text, and cannot ask its parent anything. It runs on its parent's model and thinking level unless the call or its profile names a model, and in its parent's folder unless the call names a `cwd`, such as the delegate's own git worktree. Its name is the few words its parent gives in the call, saying what sets it apart from its siblings.
- **Profile.** Who a delegate is, from the frontmatter of its instructions file: `model`, `thinking` and `readonly`, each optional. The call's `model` wins over the profile's. A profile's thinking level wins over the parent's. An unknown key fails the call, and so does a frontmatter block that never closes or starts below the first line.
- **Model alias.** A name for one model and the work it is for, `judgment`, `investigator` or `scout`, that a `delegate` call or a profile gives as its `model`, so a skill never spells a model id. It runs on the caller's provider when that provider has the model id, so a delegate stays on its parent's **Claude account**, and on the alias's own provider otherwise. Not a **role**, which is `root` or `delegate`.
- **Panel.** One model per provider, for work a skill runs once on each, such as competing designs or a review. Each entry is an alias or a `provider/id`. Two models come from different providers when their `provider/` prefixes differ.
- **Model table.** The aliases and the panel, in `features/owned-work/models.ts`. The `delegate` tool's `model` parameter lists them, so every agent that can delegate sees them.
- **Claude account.** One Claude login as its own provider: `ultra-a`, `ultra-b` or `ent`, each with Anthropic's models and its own credential in `auth.json`. `/account <name>` moves a session to another account and keeps the model. A run that ends on a 429 moves the session, root or delegate, to the same model on the next account that takes it, in the order `ultra-a`, `ultra-b`, `ent` and wrapping, so pi's own retry goes there. From `features/claude-accounts/`.
- **Read-only delegate.** A delegate whose profile sets `readonly: true`. It starts without the `edit` and `write` tools. Its bash can still write, so the instructions say so too.
- **Level.** How deep an agent sits: the root is level 1, its delegates are level 2, and theirs are level 3, the last (`levels`). An agent at the last level has no `delegate` tool. A serve or watch runs at the last level, so a pi it starts cannot delegate. The **role**, `root` or `delegate`, follows from the level.
- **Serve.** A long-running command, such as a dev server. It runs until stopped, or until the group holding it settles. Its end never wakes anyone: it is delivered in its group's result, beside a job's result, or in a `stop` reply. A serve that fails to spawn fails its own `serve` call instead.
- **Watch.** A command whose exit wakes the agent with its exit code and last lines.
- **Job.** A delegate, a watch or a group: work that settles with a result. A serve is not a job.
- **Group.** Work moved out of the agent's hands into one unit, under a name its caller gives. Mode **all** wakes the agent once with every result. Mode **each** wakes it once per result.
- **Holder.** Who receives a piece of work's result: the agent, or the group it was moved into.
- **Handle.** The plain JSON a start tool returns, such as `{ "ref": "delegate-3", "kind": "delegate", "terminal": "t7" }`.
- **Ref.** A handle's id, such as `delegate-3`. Unique within a session's transcript: a pi process numbers its refs past the highest one its session names already, so a fork or a resumed session never reuses one.
- **Settle.** A job's end: done, fired, failed, or a group's member results. The ledger also writes a settle entry when a serve ends, so every piece of work has one.
- **Deliver.** Hand a settled result to the agent, exactly once: at the end of a turn, by a wake while idle, or in a `stop` reply.
- **Wake.** A message that carries results to an idle agent and starts its next turn.
- **Ledger.** The one module that records owned work, who holds it and what was delivered. It writes the `owned-work` session entries.
- **Terminal name.** What Herdr's agents list shows for a delegate, serve or watch: the delegate's name, or the serve's or watch's command, as hc accepts it (`terminalNameOf`), such as `bun-test`. A live terminal that holds it already makes it `bun-test-2`. Each terminal sits under the agent's own, carries `ow.agent` and `ow.kind`, and, once grouped, `ow.group` and `ow.group.name`.
- **Slice.** The systemd user slice a delegate, serve or watch runs in, named `<parent's slice>-<ref without dashes>`, such as `pi-ow-1a2b3c4d-delegate3`. The root's slice is `pi-ow-<agent key>`, and the work's own work nests below its slice. Settling the work stops its slice, which ends every process in it, even one that left its process group. A user service of the same name watches the root's pid and stops the root's slice when the root dies.
- **Child session.** A delegate's own pi session, in the `delegates/` folder next to the root's sessions, so `pi -c` never opens one. Under `--no-session` the root has no session folder, so its delegates go in a `pi-delegates-<random>` folder in the temp folder, made owner-only when the first delegate starts.
- **Staged files.** A delegate's task message and, when it has any, its instructions, written as `<session id>.message` and `<session id>.instructions` beside its child session, because one argv word holds at most 128 KiB. The ledger deletes them when the delegate settles, or when its root leaves the session. A reload leaves them, because a running delegate reads its instructions each turn.

## Skill menu

Terms from the skill-menu feature (`features/skill-menu/`).

- **User-invocable.** Whether a skill shows in the `/` menu. The feature leaves out every skill whose frontmatter sets `user-invocable: false`. Pi reads no such key, so the skill still loads, the model still sees it, and typing its `/skill:<name>` in full still runs it.

## Web

Terms from the web client (`clients/web/`) and feature (`features/web/`).

- **Page.** What reading one URL gives back: the URL asked for, the final URL after redirects, a title, the source that read it, an optional caveat, and a body. The body is markdown, or a file such as a PDF with the markdown extracted from it.
- **Source.** One way to read a URL, such as GitHub's API, npm, Hacker News, Reddit, Docsify, a direct fetch, or Exa's copy. The sources sit in one ordered table. The first source that claims a URL and answers reads it.
- **Via.** The name of the source that read a page. It is shown to the model beside the page.
- **Site source.** A source that reads a site's own API or files, such as GitHub's API, npm's README, a Hacker News or Reddit thread, or a Docsify page's markdown. Its answer is the whole page, so it skips the verdict (`skipsVerdict`) and is never judged thin or a bot check. A direct fetch and Exa's copy are judged, and Exa's copy also carries a caveat.
- **Saved page.** The whole of a fetched page, written under the web cache as `<date>/<host and path>-<8 random>.md`. A file keeps its own bytes at `<...>.<ext>`, and its markdown, if any, at `<...>.<ext>.md`. web_fetch shows the head, plus the `read(path, offset)` call that continues it.
- **Untrusted content.** Page text and search highlights. They are data, never instructions. Inline text sits in one `<web_content trust="untrusted">` tag, and each saved page's first line says the same.
- **Web cache.** `${XDG_CACHE_HOME:-~/.cache}/pi-web/`, readable only by the user. With neither variable set there is none, and web_fetch fails. Date folders older than 7 days are deleted when a session starts.

## Usage

Terms from the usage feature (`features/usage/`), which shows `/usage`.

- **Card.** What `/usage` shows: one block per account and the time it read them. While it reads, the card sits under the transcript and fills in as each account answers. Then the session stores it as a custom entry, so it shows the same after a reload.
- **Block.** One account in a card: the account, where its numbers came from (its **via**), and its rows, the reason it could not be read, or that it is still being read. An account `/usage` cannot read still gets a block.
- **Meter.** One number read for an account, which becomes a row of its block: a rate-limit window's percent used and time to reset, a Claude account's extra usage against its monthly cap, or an estimate of what pi spent.
- **Probe.** A one-token message to a Claude account whose setup-token cannot read the usage page. The rate-limit headers on the reply carry the windows. A rejected reply carries them too and costs nothing.
- **Estimate.** What pi priced its own replies at, from the models' list prices in its session files. It leaves out every other client that uses the same key. `/usage` shows it for OpenAI, whose costs API needs an admin key.
