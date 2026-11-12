# pi harness

My coding harness, powered by [pi](https://github.com/earendil-works/pi) and [Herdr](https://herdr.dev/). pi is the agent. Herdr runs the terminals. This repo is pi's config folder, `~/.pi`, and adds the skills, playbooks, principles, and extensions that shape how the agent works.

The harness is built to run inside herdr-app. When the agent starts a delegate, a dev server, or a test run, that work gets its own herdr-core terminal, and herdr-app lists it under the agent that started it. You can open any of them and watch it run.

`AGENTS.md` holds the rules for working on this repo.

## Run it inside herdr-app

You need:

- [herdr-app](https://herdr.dev/), with herdr-core running.
- [pi](https://github.com/earendil-works/pi) and [bun](https://bun.sh/).
- Linux with a systemd user session. Each delegate, serve, and watch runs in its own systemd user slice, so stopping the work ends every process it started.

To set it up:

1. Clone the repo as pi's config folder: `git clone git@github.com:drsh4dow/.pi.git ~/.pi`.
2. Install the dependencies: `cd ~/.pi && bun install`.
3. Link the harness's mods into herdr-app: `ln -s ~/.pi/herdr/mods/ow-skills ~/.pi/herdr/mods/ow-work ~/.pi/herdr/mods/ow-tabs ~/.pi/herdr/mods/ow-status ~/.config/herdr-app/mods/`. In your layout (a clone of `main`), point the `tabs` block at `ow-tabs` and the `status` block at `ow-status`, and make `panel-body` a stack holding three blocks: `{ "id": "skills", "type": "block", "content": { "mod": "ow-skills" } }`, `{ "id": "trace", "type": "block", "content": { "mod": "ow-work", "props": { "view": "trace" } } }` and `{ "id": "actions", "type": "block", "content": { "mod": "ow-work", "props": { "view": "actions" } } }`. The top bar shows a button for each block the stack holds. herdr-app does not reload a linked mod when the files behind the link change, so after a pull that changes a mod, replace its link: `cd ~/.config/herdr-app/mods && ln -s ~/.pi/herdr/mods/<mod> .<mod>.new && mv -T .<mod>.new <mod>`.
4. Open a tab in herdr-app and run `pi`.

Herdr then shows the agent's work beside it:

- Each delegate, serve, and watch appears in herdr-app's agents list, under the agent that started it. A delegate shows the name its parent gave it. A serve or a watch shows its command, such as `bun-test`. Work in a group sits under the group's name.
- `/fork` and `/clone` open the copy in a new tab in the same space. The original session keeps running, and so does its work.
- The Skills panel, behind the Skills button at the top right, lists the skills, playbooks, and principles in the focused agent's context and in each of its delegates', in the order they were read. It follows `/tree` and compaction: a guide whose text left the context leaves the panel. A hollow dot and `partial` mark a guide the model saw only part of, such as a ranged read, and `you` marks one you loaded with `/skill:`.
- The Trace panel, beside Skills, shows the focused agent's work from its state folder: the `TODO.md` checklist, with the current step marked, then `decisions.tsv`, newest first. A delegate shows its root's work. The Actions panel shows each `## ` item of `USER_ACTION_ITEMS.md` as a card, and the Actions button counts the items that wait. Both follow the files every two seconds while open. The agent's terminal carries the folder it last wrote to, found from its own tool calls, so a read of another work's folder does not move it.
- The status bar at the bottom shows what the shown tab's pi session has spent at API list prices, with every delegate at any level, compactions included, whatever your plan bills. Hover it for each delegate's share. It trails a reply by up to two seconds, and the coin pulses while an agent in the tab is working. A fork counts only what it spent after the fork.

Outside herdr-app, `/fork` and `/clone` replace the current session instead of opening a tab. The `delegate`, `serve`, and `watch` tools still need herdr-core, because they start every terminal through its socket.

## Work in two phases

You settle where the work goes and how. Then you grant autonomy, and the agent builds it while you are away.

### 1. Settle the destination and the approach

The root role, `agent/roles/root.md`, defines both:

> **Destination and approach.** The destination is what the human settled the end product should be: a PRD, a ticket, or the shared understanding from a discussion. It is theirs, and a change to it is a call only the human can make. The approach is how to get there: a TRD, a plan, a spec's implementation decisions. Adapt it when the work uncovers an unknown, and record the change in the decision trail.

Settle them in a conversation with the agent. Five of Matt Pocock's skills do this phase:

- `/skill:grill-with-docs` interviews you about a plan or design in rounds of numbered questions, each with a recommended answer. It writes each term and decision to `GLOSSARY.md` and `docs/adr/` as it settles, through the `grilling` and `domain-modeling` skills.
- `domain-modeling` loads on its own when you discuss the project's terms. It challenges a word that conflicts with the glossary and records the one you settle on.
- `/skill:to-spec` turns the conversation into a spec and publishes it to the issue tracker. It asks you nothing new.
- `/skill:to-tickets` breaks a plan, a spec, or the conversation into tracer-bullet tickets, each naming the tickets that block it, and publishes them to the tracker.
- `/skill:wayfinder` is for work too big for one session. It charts a map of decision tickets on the tracker and resolves them one at a time until the way to the destination is clear.

Run `/skill:setup-matt-pocock-skills` once in each repo first. It records the repo's issue tracker (GitHub, GitLab, or local Markdown files), its triage labels, and where its glossary and ADRs live. The agent reaches GitHub through `gh`. For Linear, Jira, or another tracker, add its MCP server with `pi mcp add`.

This repo's `GLOSSARY.md` defines the destination (the PRD), the approach (the TRD), and the spec in your own words.

### 2. Grant autonomy and let the agent build

Once the destination is settled, say the words that grant autonomy, such as "run until done". The root role defines the grant:

> **Grant.** "Don't stop" / "going to bed" / "run until done" / "be fully autonomous" → keep going. The grant comes from the human's words in this session and ends with it. A grant that `STATE.md`, a handoff, a ticket, or any other artifact records is history, and a new session publishes only on the human's word in that session. It covers pushes to your work branches, PRs against shared branches, merges of PRs between your work branches, replies to reviewers on your own PRs, and updates to your own tickets. Under the grant, decide a call the grant covers, act on it, and report it, with no reply word and no offer. For a call only the human can make, apply a default, write it to `USER_ACTION_ITEMS.md` with a full explanation and what the human could tell you to do instead, and keep going on what it does not block. Gates the human named and the Always-pause list still need the human.

These always wait for you, grant or not:

> **Always pause** for irreversible writes: force-push to shared branches, deploys, data deletion, messages to people. Answering a reviewer on your own PR is not one. It is part of babysitting the PR.

Without a grant, publishing waits too:

> **Publishing** is a push, a PR, or a ticket update. It waits for the human's word unless the task names it or a grant covers it.

The agent then builds through playbooks. A playbook is the workflow for one kind of work, such as a bug fix, a feature, or opening a PR, in `agent/playbooks/`. The agent reads every playbook whose `when` line matches the work, so several can shape one session. It writes their steps into `TODO.md` in the state folder, ticks or skips each as it goes, and names each step it skips in its report as `skip: <reason>`. It does not announce which playbook it follows. The Skills panel shows the playbooks, skills, and principles it read.

### Branches and the PRs you get

The root role splits branches into the agent's and everyone's:

> **Branches.** A shared branch is one several people use, such as staging, prod, or main. Trunk is the shared branch a PR targets. Every other branch you work on is a work branch, and it is yours: create, rebase, stack, and merge between work branches as the work needs. Stacks go through `gh stack`. Never push or merge to a shared branch directly, with a grant or without one. It changes only through a PR, unless the human names the direct push. Only words about the push itself, such as "push it straight to staging", name it. "Get it on staging" asks for a PR, and when no PR can be opened, stop and say so. Your work ends in PRs against shared branches that are shaped for review: as few as keep each one self-contained, so the reviewer keeps the context and is not overwhelmed by the number of PRs. Babysit your PRs. When one is approved and nothing is outstanding, that approval is the human's word for the merge: merge it, then dogfood the live deployment, in staging and in prod.

### The state folder

Work that outlives a turn keeps its state on disk, so a new session or a compaction loses nothing:

> **State.** Work that outlives a turn keeps its state in `~/.local/state/pi-agent/<project>/<work>/`, named for the repo and the work. Put that path in each delegate's task message.
>
> - `STATE.md` holds the destination and the human's standing instructions in their words, then the decisions, the status, and the next step. Read it after a compaction and at the start of a session that continues the work.
> - `TODO.md` is the checklist of the playbooks you run, kept as `<playbooks-workflow>` says. You are its one writer.
> - `decisions.tsv` is the decision trail, per the **show-me-your-work** skill.
> - `USER_ACTION_ITEMS.md` carries everything the work needs from the human to reach the destination that you cannot do on your own: a product choice, an approval, an irreversible action, access you lack. Work you can still do yourself is not an action item. Open your report with what waits there, or say that nothing does. Each item starts at a `## <title>` line, and its body has a line starting with each label below, `**Instead.**` optional. A body may hold lists and fenced code, and outside a fence none of its lines starts with `#`. Above the first item go only the `# ` title and a plain note, such as "Nothing waits on you." A write that breaks this format comes back with its problems.
>
>    ```markdown
>    # What this work needs from you
>
>    ## Turn on required owner review for main
>
>    **The call.** PR 146 names the owners, but nothing enforces a review.
>    **My pick.** Ask an admin to add the ruleset after PR 146 merges.
>    **What it changes.** A PR to the owned paths waits for an owner.
>    **Evidence.** `main` has no branch protection and no ruleset.
>    **Risk.** Your own PRs to those paths wait for the other owner.
>    **Instead.** Tell me to drop it, and PRs merge as today.
>    ```

When you come back, read `USER_ACTION_ITEMS.md` first, or open the Actions panel. It holds every call the agent left for you, with the default it applied and what you could tell it to do instead.

### Three roles

The agent you talk to is the root, and it hands each slice of the work to an owner: a delegate that builds, verifies, commits, and reports on that slice, and that can start delegates of its own. A leaf is a delegate on one bounded task, such as a search, a review, or a scoped edit, and it never runs a playbook or starts a delegate.

### Force a guide

When the agent misses a skill, run it with `/skill:<name>`. Skills with `user-invocable: false` stay out of the `/` menu, and typing the name in full still runs them. A playbook has no command. Name its file instead, as in "follow `playbooks/bug-fix.md`".

## What to say

Type any of these requests as written. The skill or playbook each one is meant to load is in the last column.

| Say                                                                             | What the agent does                                                                                                                | Guide                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| "/skill:grill-with-docs I want to add team billing"                             | Asks the open questions in rounds, each with a recommended answer, and records each term and decision as it settles                | `grill-with-docs`               |
| "Grill me on this plan"                                                         | Asks every open question in rounds, each with a recommended answer                                                                 | `grilling`                      |
| "I have a rough idea for a habit tracker, help me refine it"                    | Explores variations with you, then writes a one-page concept with a Not doing list                                                 | `idea-refine`                   |
| "/skill:to-spec"                                                                | Turns the conversation so far into a spec on the issue tracker                                                                     | `to-spec`                       |
| "/skill:to-tickets"                                                             | Breaks the spec into tickets with their blocking edges on the issue tracker                                                        | `to-tickets`                    |
| "/skill:wayfinder Move billing to Stripe"                                       | Charts the decisions between here and the destination as a map of tickets, then resolves them one at a time                        | `wayfinder`                     |
| "Build tickets #43 to #47. I'm going to bed, run until done."                   | Grants autonomy for the session, states the exit condition, and drives the work to it                                              | `autonomous-run`, `feature`     |
| "Own this migration until it lands"                                             | Coordinates the whole project across many stacked PRs and delegates                                                                | `orchestrate`                   |
| "Fix this bug: splitCents(100, 3) returns [33, 33, 33] and a cent goes missing" | Reproduces the bug, binary-searches the cause, and writes a test that fails before the fix and passes after                        | `bug-fix`, `tdd`                |
| "Add CSV export to the invoices page"                                           | Maps the subsystem, designs the change, hands the build to owners, and verifies it                                                 | `feature`                       |
| "Try both layouts and pick one"                                                 | Builds a throwaway sketch of each and lets the result decide                                                                       | `prototype`                     |
| "How does the retry queue work?"                                                | Answers from the code with citations, and changes nothing                                                                          | `investigation`, `how`          |
| "Why does checkout retry three times?"                                          | Gives a cited answer from git history and the other evidence it can reach                                                          | `why`                           |
| "Review PR #123"                                                                | Reviews correctness, readability, architecture, security, and performance. Each finding is Critical, Required, Optional, or Nit    | `code-review-and-quality`       |
| "What could PR #123 break?"                                                     | Maps what the change could break beyond its diff                                                                                   | `blast-radius`                  |
| "Interrogate PR #123"                                                           | Has adversaries on several models try to break the change, and keeps only the findings a run proves                                | `interrogate`                   |
| "Simplify src/billing/, it works but it is hard to read"                        | Simplifies the code and keeps its behavior                                                                                         | `code-simplification`           |
| "Babysit PR #12"                                                                | Clears conflicts, review threads, and CI until the PR is merge-ready                                                               | `babysit`                       |
| "Ship the stack"                                                                | Verifies each PR independently, then lands the verified run bottom-up through `gh stack`                                           | `shipping`                      |
| "What needs to be in place before shipping this to production?"                 | Starts the code-reviewer, security-auditor, and test-engineer delegates in parallel, then returns go or no-go with a rollback plan | `shipping-and-launch`           |
| "The invoices page at https://staging.example.com/invoices is slow"             | Starts the web-performance-auditor delegate. A URL gets measured numbers, and source files alone get likely issues                 | `performance-optimization`      |
| "Set up quality constraints for this project"                                   | Interviews you and writes `CONSTRAINTS.md`                                                                                         | `constraint-driven-development` |
| "Catch me up"                                                                   | Says what changed since your last message and every call that waits on you                                                         | `ketchup`                       |
| "Pause, I'm going offline"                                                      | Stops at a safe boundary, commits a `wip:` checkpoint, and writes a resume note                                                    | `pause-safely`                  |
| "Where did we leave off on billing?"                                            | Rebuilds a current-state brief from session history and the live state of the work                                                 | `recall`                        |
| "Run an arena on the cache design"                                              | Runs parallel candidates, picks a base, and grafts in the best parts of the rest                                                   | `arena`                         |
| "Swarm the flaky tests, one worker per test file"                               | Fans out parallel workers and returns one report                                                                                   | `swarm`                         |
| "Sharpen this task"                                                             | Makes the task deeper, not bigger, and rewrites its prompt                                                                         | `sharpen`                       |

For a small change, say it: "rename `fetchUser` to `loadUser`" or "commit this".

## Two commands

The harness has no prompt templates. The extensions add two commands. `/account <name>` moves the session to another Claude account and keeps the model. `/usage` shows what every account has used.

## What's in the repo

- `agent/skills/` holds the skills.
- `agent/playbooks/` holds the playbooks. The files in its subfolders are their reference files and scripts.
- `agent/principles/` holds the hard rules an agent reads when a principle's `when` line matches its task.
- `agent/SYSTEM.md` and `agent/roles/` make up the system prompt. `agent/instructions/` holds the delegate briefs, such as `code-reviewer.md`.
- `agent/extensions/`, `features/`, and `clients/` hold the TypeScript extensions. `docs/adr/0001-harness-layout.md` explains how the code splits across them.
- `GLOSSARY.md` defines the terms the code uses, such as delegate, serve, watch, and group.
