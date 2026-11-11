# pi harness

My coding harness, powered by [pi](https://github.com/earendil-works/pi) and [Herdr](https://herdr.dev/). pi is the agent. Herdr runs the terminals. This repo is pi's config folder, `~/.pi`, and adds the skills, principles, and extensions that shape how the agent works.

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
3. Link the harness's mods into herdr-app: `ln -s ~/.pi/herdr/mods/ow-skills ~/.pi/herdr/mods/ow-tabs ~/.pi/herdr/mods/ow-status ~/.config/herdr-app/mods/`. In your layout (a clone of `main`), point the `tabs` block at `ow-tabs` and the `status` block at `ow-status`, and make `panel-body` a stack holding one block, `{ "id": "skills", "type": "block", "content": { "mod": "ow-skills" } }`.
4. Open a tab in herdr-app and run `pi`.

Herdr then shows the agent's work beside it:

- Each delegate, serve, and watch appears in herdr-app's agents list, under the agent that started it. A delegate shows the name its parent gave it. A serve or a watch shows its command, such as `bun-test`. Work in a group sits under the group's name.
- `/fork` and `/clone` open the copy in a new tab in the same space. The original session keeps running, and so does its work.
- The Skills panel, behind the Skills button at the top right, lists the skills and principles in the focused agent's context and in each of its delegates', in the order they were read. It follows `/tree` and compaction: a guide whose text left the context leaves the panel. A hollow dot and `partial` mark a guide the model saw only part of, such as a ranged read, and `you` marks one you loaded with `/skill:`.
- The status bar at the bottom shows what the shown tab's pi session has spent at API list prices, with every delegate at any level, compactions included, whatever your plan bills. Hover it for each delegate's share. It trails a reply by up to two seconds, and the coin pulses while an agent in the tab is working. A fork counts only what it spent after the fork.

Outside herdr-app, `/fork` and `/clone` replace the current session instead of opening a tab. The `delegate`, `serve`, and `watch` tools still need herdr-core, because they start every terminal through its socket.

## Say what you want in plain words

Brief the agent the way you would brief an engineer. No kind of work has its own command to learn. Every request goes through the same four steps:

1. **You describe the work.** A bug report, a PR number, a ticket, a rough idea, or the path to a requirements doc is enough.
2. **The agent loads its guides.** It loads each skill in `agent/skills/` that your request matches, and each principle in `agent/principles/` whose `when` line matches. A bug report loads `test-driven-development`, and "grill me" loads `grilling`. The Skills panel shows what it loaded.
3. **The agent does the work and proves it.** It writes the code, runs the tests and the app, and commits each slice it verified. It hands bulk reading, reviews, and second opinions to delegates, some of them on another model family, and you can watch each one in herdr-app.
4. **The agent reports.** The report says what changed, how the agent checked it, and which principle changed a decision.

The agent stops and waits for you in three cases:

- **It is confused.** The request, the spec, and the code disagree, and running something cannot settle it.
- **The next step is public or cannot be undone.** A push, a PR, a comment, a deploy, or deleted data needs your yes, unless your request named that step.
- **A decision is yours.** Product behavior, a contract other code builds on, or scope you did not name. The agent lists its assumptions and waits.

Everything else the agent decides, does, and explains in its report, so you can correct it afterwards.

When the agent misses a skill, force it with `/skill:<name>`. Skills with `user-invocable: false` stay out of the `/` menu, and typing the name in full still runs them.

## What to say

Type any of these requests as written. The skill each one is meant to load is in parentheses.

| Say                                                                                           | What the agent does                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Interview me about what I actually want before you build anything"                           | Asks one question at a time, each with its own guess, until the intent is clear (`interview-me`)                                                            |
| "I have a rough idea for a habit tracker, help me refine it"                                  | Explores variations with you, then writes a one-page concept with a Not doing list (`idea-refine`)                                                          |
| "Grill me on this plan"                                                                       | Asks every open question in rounds, each with a recommended answer (`grilling`)                                                                             |
| "Write a spec for the new billing feature before we write any code"                           | Asks about what the request leaves open, then writes `SPEC.md` (`spec-driven-development`)                                                                  |
| "Break this spec into small verifiable tasks with acceptance criteria"                        | Reads only, then writes `tasks/plan.md` and `tasks/todo.md` for you to review (`planning-and-task-breakdown`)                                               |
| "Fix this bug: splitCents(100, 3) returns [33, 33, 33] and a cent goes missing"               | Writes a failing test that reproduces the bug, then the fix (`test-driven-development`)                                                                     |
| "This test passed yesterday and fails today, figure out what broke"                           | Finds the root cause before it changes anything (`debugging-and-error-recovery`)                                                                            |
| "Review this pull request before I merge it"                                                  | Reviews correctness, readability, architecture, security, and performance. Each finding is Critical, Required, Optional, or Nit (`code-review-and-quality`) |
| "What could PR #123 break?"                                                                   | Maps what the change could break beyond its diff (`blast-radius`)                                                                                           |
| "Interrogate PR #123"                                                                         | Has adversaries on several models try to break the change, and keeps only the findings a run proves (`interrogate`)                                         |
| "Simplify this function, it works but it is hard to read"                                     | Simplifies the code and keeps its behavior (`code-simplification`)                                                                                          |
| "We have no written standards. Ask me what I care about and write it down with sane defaults" | Interviews you and writes `CONSTRAINTS.md` (`constraint-driven-development`)                                                                                |
| "What needs to be in place before shipping this to production?"                               | Starts the code-reviewer, security-auditor, and test-engineer delegates in parallel, then returns go or no-go with a rollback plan (`shipping-and-launch`)  |
| "The invoices page at https://staging.example.com/invoices is slow"                           | Starts the web-performance-auditor delegate. A URL gets measured numbers, and source files alone get likely issues (`performance-optimization`)             |
| "How does the retry queue work?"                                                              | Walks through the code's runtime behavior (`how`)                                                                                                           |
| "Why does checkout retry three times?"                                                        | Gives a cited answer from git history and the other evidence it can reach (`why`)                                                                           |
| "Run an arena on the cache design"                                                            | Runs parallel candidates, picks a base, and grafts in the best parts of the rest (`arena`)                                                                  |
| "Swarm the flaky tests, one worker per test file"                                             | Fans out parallel workers and returns one report (`swarm`)                                                                                                  |
| "Sharpen this task"                                                                           | Makes the task deeper, not bigger, and rewrites its prompt (`sharpen`)                                                                                      |

For a small change, say it: "rename `fetchUser` to `loadUser`" or "commit this".

## Two commands

The harness has no prompt templates. The extensions add two commands. `/account <name>` moves the session to another Claude account and keeps the model. `/usage` shows what every account has used.

## Start from where the work arrives

Most work arrives mid-process, as a PR to review, a ticket on the board, or requirement docs someone else wrote. Join the lifecycle at the phase the work is in, and skip the phases it already passed.

### Review someone else's PR

1. Say "review PR #123 in a worktree". The agent reads the PR and runs its tests in a separate worktree, so your branch stays as it is. It lists findings as Critical, Required, Optional, or Nit.
2. If the PR touches auth, data, payments, or a migration, ask "what could PR #123 break" or say "interrogate PR #123".
3. Pick the verdict. Approve when the change improves the code, even if it is not perfect. Request changes when a Critical or Required finding is open.
4. Say "post it as request changes" or "approve it". The agent shows you the review text and asks before it runs `gh pr review`, because posting sends a message to other people.

### Plan a ticket from the board

First, decide how big the ticket is.

- **One PR with a clear scope.** Skip the spec and the plan. Say "implement #42". A bug gets a failing test first.
- **A vague ticket.** Say "interview me about #42" until you know what you want. Then treat it as a project.
- **A project.**
   1. Say "write a spec for #42", then approve `SPEC.md`.
   2. Say "plan the spec and file the tasks as sub-issues of #42". The tasks go to the tracker instead of `tasks/todo.md`, and `tasks/plan.md` keeps the design and the risks.
   3. For each sub-issue, say "implement #43", then "review it", and merge. One sub-issue is one PR.

The agent reaches GitHub through `gh`. For Linear, Jira, or another tracker, add its MCP server with `pi mcp add`, and the agent and its delegates read the tickets themselves. Without a server, paste the ticket text into your request.

### Implement a PRD and a TRD

A PRD says what to build and why. A TRD says how. Neither one is a spec, because both leave out the commands, the test strategy, the boundaries, and the places where the two docs disagree.

1. Say "write a spec that implements docs/prd.md following docs/trd.md". The agent reads both docs and the code, asks only about what they leave out, and writes `SPEC.md` with the two docs as its sources. A conflict between the docs becomes a blocking open question.
2. Settle the open questions, then approve `SPEC.md`. If the PRD covers several features that can ship separately, the agent proposes a capability map first, and you get one spec per feature.
3. Say "plan it", or "plan it and file the tasks as sub-issues of #42" if the work has an epic.
4. Say "build the next task", or "build the plan" to hand each task to an owner delegate. Each task gets a failing test first and its own commit.
5. Say "review the branch", then "prepare the deploy". The second loads `shipping-and-launch`, which starts the three reviewer delegates and returns go or no-go with a rollback plan.

### Smaller entry points

- **A bug report.** Paste it: "splitCents(100, 7) returns cents that sum to 98".
- **Code that works but is hard to read.** Say "simplify src/billing/", then "review it".
- **A repo with no written quality bar.** Say "set up quality constraints for this project". Before a merge, say "check this diff for a lowered quality bar", which catches skipped tests and new lint suppressions.
- **A slow page.** Say "the invoices page at https://staging.example.com/invoices is slow". `performance-optimization` starts the web-performance-auditor delegate, which measures the URL.

## What's in the repo

- `agent/skills/` holds the skills.
- `agent/principles/` holds the hard rules an agent reads when a principle's `when` line matches its task.
- `agent/SYSTEM.md` and `agent/roles/` make up the system prompt. `agent/instructions/` holds the delegate briefs, such as `code-reviewer.md`.
- `agent/extensions/`, `features/`, and `clients/` hold the TypeScript extensions. `docs/adr/0001-harness-layout.md` explains how the code splits across them.
- `GLOSSARY.md` defines the terms the code uses, such as delegate, serve, watch, and group.
