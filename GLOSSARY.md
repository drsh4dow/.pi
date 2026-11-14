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
- **Role layer.** The `<role>` and `<collaboration>` blocks from the role file of the agent's **role**, then a delegate's `<instructions>`. It comes right after the shared layer.
- **Role file.** `agent/roles/<role>.md`, one per **role**: `root.md`, `owner.md` and `leaf.md`. Each file is the text the model reads, tags included. What sets one level apart comes with the `delegate` tool and its guidelines, so the owners at every level share a file, and so do the leaves.
- **Instructions.** A persona or one delegate's job, such as a cold reader or a code reviewer. It comes from the body of a file the parent names when it starts the delegate, either one of the harness's persona files or a prompt file inside a skill. The parent reads the file at the start and keeps a copy of the body in the delegate's **brief**, so a later edit never reaches a running child. The file's frontmatter is its **profile**, under Owned work below. Instructions never carry the **project facts** every delegate of a piece of work needs, or the **owner rules** only its owners follow. The harness hands those to delegates itself.
- **Project facts.** What every delegate of one piece of work needs to know about its project, such as its commands, conventions and hazards. The root keeps them in the state folder, and the harness reads them into each delegate's prompt when the delegate starts, so no task message has to repeat them. Not **instructions**, which a call names for one delegate.
- **Owner rules.** The rules of one piece of work that only an owner follows, such as how it builds and ships its slice. They sit beside the project facts, and the harness reads them into an owner's prompt only, so a leaf never sees them. Not the owner's **role file**, which every owner of every piece of work shares.
- **Principle.** A hard rule that steers how an agent thinks, in `agent/principles/<name>.md`. Its frontmatter has a one-line `when` and an optional `for` naming the roles it fits, every role when absent. The prompt names the principles folder once in `<principles dir="…">`, then lists each fitting principle as `name: when`, and the agent reads `<name>.md` when the `when` might match. A skill, a role file, or an answer points at one as `principle-<name>`. A principle stands alone: it names no other principle, and the agent reaches it only through its own `when`.
- **Skills section.** The `<skills>` section the prompt feature writes in pi's place: the skills rule, then each skill the role may invoke as `name: description`, in one list per folder that names the folder once. A skill's `for` names its roles, as a principle's does; without it, every role. A hidden skill also leaves pi's own list.
- **Tool context.** The `<rules>` list (each tool's and extension's guidelines) that pi writes into its default prompt. A custom preamble makes pi drop it, so the prompt feature adds it back. It does not add back pi's `<tools>` list, whose lines restate each tool's schema description, or `<docs>`, which `AGENTS.md` carries for work on this harness. It leaves out pi's generic rules (the bash file-ops rule, "Be concise", "Show file paths clearly"), the guidelines of `edit` and `codemode`, which restate their schema and `<codemode>`, and the "Additional tools may be available" line, since `SYSTEM.md` sets its own style.
- **Playbook.** The workflow for one kind of work, such as a bug fix or opening a PR, in `agent/playbooks/<name>.md`. Its frontmatter is a principle's: a one-line `when` and an optional `for`. The prompt lists each fitting playbook as `name: when` in `<playbooks dir="…">`, and the agent reads every one whose `when` matches, so several can shape one session. A skill or another playbook points at one as `playbooks/<name>.md`. See ADR 0005.
- **Reference file.** A file in a subfolder of `agent/playbooks/`, such as a script or a checklist that a playbook points at. It is not a playbook, and the prompt never lists it.
- **Trigger.** The line the model matches a task against: a skill's `description`, or a principle's or a playbook's `when`.

## Owned work

Terms from the owned-work feature (`features/owned-work/`).

- **Owned work.** Every delegate, serve, watch and group a pi process started. It survives a reload, and stops when the process quits or leaves its session: `/new`, `/resume`, or a fork outside herdr-app. See ADR 0002.
- **Handover.** What a reload passes from one load of the owned-work extension to the next in the same process: the ledger's state and the agent key, so the work keeps running. A reload that changed the ledger's own types refuses it and stops the work.
- **Agent key.** Eight characters that name one pi's terminals in hc (`ow.agent`) and its slice. A reload keeps it, and any other session start picks a new one.
- **Fork tab.** Where `/fork` and `/clone` put the copy in a herdr-app tab: a new pi in a new tab of the same space, focused, while the source tab keeps its session and its work. The copy notes which work kept running in the source.
- **Delegate.** A child pi its parent starts on one task message, as an **owner** or a **leaf**. Each run ends in one reply, its **answer**, and it cannot ask its parent anything. It runs on the model the call or its profile names, and a call where neither names one fails. It runs in its parent's folder unless the call names another, such as the delegate's own git worktree. It is known by its child session and its name. The name is the few words its parent gives in the call to set it apart, and no other live delegate of the same parent holds it. A wake that carries its result names both.
- **Brief.** What a delegate starts from, set by its parent's call and kept for the delegate's life: its task message, the **goal**, the state folder, the **project facts** and its **instructions**. An owner's brief also holds its **design** and the **owner rules**. A leaf's brief never holds owner rules.
- **Goal.** What the human's work is for, in one statement that every delegate's prompt carries. A root names it in each delegate call, and a call without one fails. A delegate's own calls inherit it and may replace it, so no task message restates it.
- **Continuation.** Another run of a delegate in its own child session, which its parent starts with a new message. A parent starts one after the delegate failed, such as on a provider error, or to follow up on a delegate that finished. Nothing starts one on its own, so a failed delegate stays failed until its parent decides. Not a new delegate, since it keeps its name and child session.
- **Answer.** The last assistant text of a delegate's run, its reply to its parent. The wake that carries it holds the answer up to the **answer cap**, and the whole answer stays in a file the parent can read.
- **Answer cap.** The most of an answer that one wake carries. One cap holds for every delegate, and no call sets its own.
- **Profile.** Who a delegate is, from the frontmatter of its instructions file: `model`, `thinking`, `readonly` and `role`, each optional. The call's `model` and `role` win over the profile's. Without a profile's thinking level, a delegate starts at `high`, whatever its parent's. An unknown key fails the call, and so does a frontmatter block that never closes or starts below the first line.
- **Model alias.** A name for one model and the work it is for, `judgment`, `investigator` or `divergent`, that a `delegate` call or a profile gives as its `model`, so a skill never spells a model id. It runs on the caller's provider when that provider has the model id, so a delegate stays on its parent's **Claude account**, and on the alias's own provider otherwise. Not a **role**.
- **Panel.** One model per provider, for work a skill runs once on each, such as competing designs or a review. Each entry is an alias or a `provider/id`. Two models come from different providers when their `provider/` prefixes differ.
- **Model table.** The aliases and the panel, in `features/owned-work/models.ts`. The `delegate` tool's `model` parameter lists them, so every agent that can delegate sees them.
- **Claude account.** One Claude login as its own provider: `ultra-a`, `ultra-b` or `ent`, each with Anthropic's models and its own credential in `auth.json`. `/account <name>` moves a session to another account and keeps the model. A run that ends on a 429 moves the session, root or delegate, to the same model on the next account that takes it, in the order `ultra-a`, `ultra-b`, `ent` and wrapping, so pi's own retry goes there. From `features/claude-accounts/`.
- **Role.** What an agent is for: `root`, `owner` or `leaf`. It picks the agent's role file, whether it has the `delegate` tool, and which skills, principles and playbooks its prompt lists. The root is the pi at the human's terminal. A delegate's parent names its role in the `delegate` call or through the profile, and a call where neither does fails.
- **Owner.** A delegate handed one slice to build, verify, commit and report on. Its prompt lists the playbooks, and at every level it can hand parts of its slice to delegates of its own. At the last level it starts leaves only. Its parent hands it a **design** with the slice. See ADR 0008.
- **Design.** Who settled the shape of an owner's slice, named when its parent starts it. It is either a sketch made before the hand-off, which the owner builds to, or the owner's own to choose before it builds. A start that names neither fails. A sketch counts only when it exists and records its synthesis decision, and nothing deeper in it is checked. An owner at the last level can be handed the choice too, and then works out its design with leaves.
- **Leaf.** A delegate handed one bounded task, such as a search, a review, a verification lane or a scoped edit. It never has the `delegate` tool, at any level, and its prompt lists only the playbooks whose `for` names it. A pi that a serve or watch starts is a leaf.
- **Read-only delegate.** A delegate whose profile sets `readonly: true`. It starts without the `edit` and `write` tools. Its bash can still write, so the instructions say so too. Read-only is apart from the **role**: a leaf can edit what its task scopes.
- **Level.** How deep an agent sits. The root is level 1, its delegates are level 2, and theirs are level 3, the last level, as deep as an owner can sit. An owner at the last level starts leaves only, and they sit at level 4, one below it. A leaf starts no delegates, so no agent sits deeper than level 4. A serve or watch runs at level 3. The level only caps depth. The **role** decides whether a delegate may delegate at all. See ADR 0008.
- **Serve.** A long-running command, such as a dev server. It runs until cancelled, or until the group holding it settles. Its end never wakes anyone: it is delivered in its group's result, beside a job's result, or in a `cancel` reply. A serve that fails to spawn fails its own `serve` call instead.
- **Watch.** A command whose exit wakes the agent with its exit code and last lines.
- **Job.** A delegate, a watch or a group: work that settles with a result. A serve is not a job.
- **Group.** Work moved out of the agent's hands into one unit, under a name its caller gives. It wakes the agent once with every result, once all its jobs settle. When a `cancel` settles its last job, that `cancel` reply carries the result instead. A delegate started with a `group` name joins the live group of that name the agent holds, or starts one.
- **Holder.** Who receives a piece of work's result: the agent, or the group it was moved into.
- **Handle.** The plain JSON a start tool returns, such as `{ "ref": "delegate-3", "kind": "delegate", "terminal": "t7" }`.
- **Ref.** A handle's id, such as `delegate-3`. Unique within a session's transcript: a pi process numbers its refs past the highest one its session names already, so a fork or a resumed session never reuses one.
- **Settle.** A job's end: done, fired, failed, or a group's member results. The ledger also writes a settle entry when a serve ends, so every piece of work has one.
- **Deliver.** Hand a settled result to the agent, exactly once: at the end of a turn, by a wake while idle, or in a `cancel` reply.
- **Wake.** A message that carries results to an idle agent and starts its next turn.
- **Ledger.** The one module that records owned work, who holds it and what was delivered. It writes the `owned-work` session entries.
- **Terminal name.** What Herdr's agents list shows for a delegate, serve or watch: the delegate's name, or the serve's or watch's command, as hc accepts it (`terminalNameOf`), such as `bun-test`. A live terminal that holds it already makes it `bun-test-2`. Each terminal sits under the agent's own, carries `ow.agent` and `ow.kind`, and, once grouped, `ow.group` and `ow.group.name`.
- **Slice.** The systemd user slice a delegate, serve or watch runs in, named `<parent's slice>-<ref without dashes>`, such as `pi-ow-1a2b3c4d-delegate3`. The root's slice is `pi-ow-<agent key>`, and the work's own work nests below its slice. Settling the work stops its slice, which ends every process in it, even one that left its process group. A user service of the same name watches the root's pid and stops the root's slice when the root dies.
- **Child session.** A delegate's own pi session, in the `delegates/` folder next to the root's sessions, so `pi -c` never opens one. Under `--no-session` the root has no session folder, so its delegates go in a `pi-delegates-<random>` folder in the temp folder, made owner-only when the first delegate starts.
- **Staged files.** A delegate's task message and its **brief**, written beside its child session, because one argv word holds at most 128 KiB. The ledger deletes them when the delegate settles, or when its root leaves the session, and a **continuation** stages them again. A reload leaves them, because a running delegate still reads them.

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

## Cost

Terms from the cost feature (`features/cost/`), the cache feature (`features/cache/`) and herdr-app's status bar (`herdr/mods/ow-status/`).

- **Spend.** What a session priced its model calls at: replies, tool results that called a model, compactions, branch summaries and cache-warm calls, at the list price pi stored on each. A fork's spend starts at its own header. Unlike an **Estimate**, it covers one session tree, delegates included.
- **Cache miss.** A reply that rewrote its cached prompt at full price: the prompt is at least 50,000 tokens, it read at most max(1,000, 1% of the prompt) from the cache, and an earlier call in the session had written the cache. The root and every delegate record each one as a `pi.cache-miss` entry just before the reply, with the missed tokens and every cause that held: idle past 5 minutes since the last reply or cache-warm call, a model change, a compaction, a context edit, a changed system prompt, changed tools. An empty list is a miss nothing there explains. The model never sees the entry.
- **Cost label.** The `pi.cost` hc label on a root agent's own terminal: JSON with the root's own spend and each delegate's below it, at any level. Only the root writes one, from the session files, so a delegate that settled still counts. See ADR 0004.

## Loaded

Terms from the loaded feature (`features/loaded/`) and herdr-app's Skills panel (`herdr/mods/ow-skills/`).

- **Guide.** A skill's `SKILL.md`, a principle's `<name>.md`, or a playbook's `<name>.md`: a file of instructions an agent reads into its context when its trigger matches.
- **In context.** A guide is in context when the lines of its body that no other guide shares appear in text the model sees now: a tool result, a user message, a summary. pi's session projection decides what the model sees, after the branch, the latest compaction and context edits. A guide is **partial** when fewer than 90% of those lines appear, and at least three do, or all of them when it has fewer.
- **Context label.** The `pi.context` hc label on an agent's own terminal: JSON with the guides in its context and how many skills and principles it could load. Each pi writes its own, so the panel finds a delegate's guides on the delegate's terminal. See ADR 0003.

## Compaction

Terms for what an agent keeps when pi compacts its session. See ADR 0010.

- **Compaction summary.** The text that stands in for the turns a compaction drops. The harness writes it, in the root and in every delegate. It holds the **anchor**, the **narrative**, the **restored guides**, and the names of the **listed guides**. A guide whose body is still in the messages pi keeps after the compaction stays in context, so the summary neither restores nor lists it.
- **Anchor.** The document a compaction summary carries whole. A root's anchor is the state file in its state folder, and a delegate's is its task message. A root without a state folder has none.
- **Narrative.** The part of a compaction summary that tells the work so far. It keeps the goal, the constraints still in force, the open work and the next steps. It drops finished history, which a root keeps in its decision trail and a delegate in its session.
- **Guide budget.** How much guide text one compaction summary restores. Guides restore in the order the agent first loaded them, up to the budget.
- **Restored guide.** A guide that was **in context** before a compaction and fits in the guide budget, whose body the compaction summary carries as its file reads at that moment. It stays in context after the compaction, and the context label shows it as loaded even when its file changed after the session began. Not a reload, which restarts pi's extensions.
- **Listed guide.** A guide that was in context before a compaction but falls past the guide budget. The summary names it with a line telling the agent to read it again, and the context label shows it as not loaded until the agent does.

## Merge

Terms for what lets an agent merge a pull request. See ADR 0009.

- **Verdict.** A verifier's recorded result on one pull request at one head commit: a pass, a pass with notes, a fail, or incomplete. Incomplete is not a fail. It means the verifier could not finish, or its answer carried no verdict line. Only a pass or a pass with notes lets the pull request merge. Not the check a direct fetch gets in Web.
- **Carry.** A verdict carries to a newer head when the pull request's diff there is the same patch as at the verdict's head, whitespace included, as after a rebase that changed nothing in it. Every other new head needs a fresh verdict, even one that changed only tests or docs.
- **Merge gate.** The check that runs before an agent merges a pull request and refuses the merge unless a pass verdict sits at the head or carries to it. It covers every merge an agent makes through the GitHub command line tool that reaches it, including a merge between work branches that a grant allows and a pull request that changes only docs. ADR 0009 names the merges it does not see. It refuses a merge that GitHub would complete later, so an agent waits for the pull request's checks and then merges with the head pinned. A merge that lands several pull requests needs a pass at each of them, and the gate refuses it when it cannot tell which they are. No agent has an override. It runs on the agent's machine, not on GitHub, so the human can merge past it from his own shell or GitHub's site.

## Work

Terms from the root role (`agent/roles/root.md`) for the work the human hands the agent.

- **Destination.** What the end product should be, settled with the human. Only the human changes it. Its document is the **PRD**, in the human's words "the shared understanding we settle in a discussion about the end product ... it settles the destination".
- **Approach.** How the work reaches the destination. Its document is the **TRD**, which "defines the selected approach but is more malleable", because "things has to be adapted given the discoveries of unknowns". The agent adapts it and records each change in the decision trail.
- **Spec.** The document that joins the destination and the approach. In the human's words, "the spec armonizes both".
- **Grant.** The human's words, such as "run until done", that let the agent work without stopping for the rest of the session. It covers pushes to work branches, PRs against shared branches, merges of PRs between work branches, and updates to the agent's own tickets.
- **Shared branch.** In the human's words, "a branch that is used by multiple people, for example staging or prod", or main. The agent's work reaches one only through PRs.
- **Trunk.** The shared branch a PR targets. Not to be confused with main: a PR against staging has staging as its trunk.
- **Work branch.** A branch that is not shared. It is the agent's own to create, rebase, stack, and merge PRs between.
- **State folder.** `~/.local/state/pi-agent/<project>/<work>/`, where work that outlives a turn keeps `STATE.md`, its todo list, its decision trail, and its action items.
- **Todo list.** `TODO.md` in the state folder: each playbook the root runs, as `## <playbook>` and one line per numbered step, open `- [ ]`, done `- [x]` or skipped `- [-] ... skip: <reason>`, plus the root's own items under `## task`. The first open line is the current step. Only the root writes it.
- **State label.** The `pi.state` hc label on a root agent's own terminal: the state folder its session last wrote to, found by checking which folder a tool call's arguments name changed while it ran. Delegates do not load the extension. See ADR 0007.
- **Trace and Actions panels.** herdr-app panels (`herdr/mods/ow-work/`), one mod shown with `view` `trace` or `actions`. They read the state label of the focused agent's root and draw its todo list and decision trail, or its action items.
- **Decision trail.** `decisions.tsv` in the state folder: one row per decision the agent made, with its why, evidence, and result.
- **Action item.** Something the work needs from the human that no agent can do on its own, kept with the other action items in the state folder. Each one gives its **only-you reason**.
- **Only-you reason.** The line of an action item that says why only the human can do it, as one of these kinds: a decision, an approval, an irreversible action, or access the agent lacks. An access item points at the record of the denied attempt, and that record must exist.
