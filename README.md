# pi harness

My coding harness, powered by [pi](https://github.com/earendil-works/pi) and [Herdr](https://herdr.dev/). pi is the agent. Herdr runs the terminals. This repo is pi's config folder, `~/.pi`, and adds the skills, slash commands, principles, and extensions that shape how the agent works.

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
3. Link the Skills panel into herdr-app: `ln -s ~/.pi/herdr/mods/ow-skills ~/.pi/herdr/mods/ow-tabs ~/.config/herdr-app/mods/`. In your layout (a clone of `main`), point the `tabs` block at `ow-tabs` and make `panel-body` a stack holding one block, `{ "id": "skills", "type": "block", "content": { "mod": "ow-skills" } }`.
4. Open a tab in herdr-app and run `pi`.

Herdr then shows the agent's work beside it:

- Each delegate, serve, and watch appears in herdr-app's agents list, under the agent that started it. A delegate shows the name its parent gave it. A serve or a watch shows its command, such as `bun-test`. Work in a group sits under the group's name.
- `/fork` and `/clone` open the copy in a new tab in the same space. The original session keeps running, and so does its work.
- The Skills panel, behind the Skills button at the top right, lists the skills and principles in the focused agent's context and in each of its delegates', in the order they were read. It follows `/tree` and compaction: a guide whose text left the context leaves the panel. A hollow dot and `partial` mark a guide the model saw only part of, such as a ranged read, and `you` marks one you loaded with `/skill:`.

Outside herdr-app, `/fork` and `/clone` replace the current session instead of opening a tab. The `delegate`, `serve`, and `watch` tools still need herdr-core, because they start every terminal through its socket.

## Prompts are for you, skills are for the agent

A skill in `agent/skills/` describes how to do one kind of work. The agent reads the skill descriptions and loads a skill when your request matches it, so you never have to name one. A bug report loads `test-driven-development`, and "grill me" loads `grilling`. Skills with `user-invocable: false` stay out of the `/` menu. To force one of them, type `/skill:<name>` in full.

A prompt in `agent/prompts/` is a command you type to pick the lifecycle phase. Each prompt loads its skills and stops at a fixed point, so you check the result before the next phase starts. `/ship` and `/webperf` also start reviewer delegates, which a plain request doesn't do.

Type a command when you want to choose the phase and where the agent stops. For a small change, ask in plain words.

| Command                                | Use it when                            | What it adds                                                                                                                    |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/spec [what to build]`                | A feature or project has no spec yet   | Asks you questions and writes `SPEC.md` before any code                                                                         |
| `/plan [focus]`                        | You have a spec and want tasks         | Reads only. Writes `tasks/plan.md` and `tasks/todo.md` for you to review                                                        |
| `/build`                               | You want the next task on the plan     | One task: failing test, code, full suite, build, commit. Then it stops                                                          |
| `/build auto`                          | You trust the plan                     | You approve the plan once, and it runs every task with one commit each. It stops on failures, gaps in the spec, and risky steps |
| `/test [feature or bug]`               | You want test-first work               | A failing test first, then the fix. A bug gets a test that reproduces it                                                        |
| `/review [scope or focus]`             | Before you merge                       | A review on five axes: correctness, readability, architecture, security, and performance. Findings have `file:line`             |
| `/code-simplify [scope]`               | The code works but is hard to read     | Simpler code with the same behavior, tested after each change                                                                   |
| `/constraints [check\|guard\|ratchet]` | The project has no written quality bar | Interviews you and writes `CONSTRAINTS.md`. `guard` checks a diff for a lowered bar                                             |
| `/ship [scope]`                        | Before you deploy                      | Starts the code-reviewer, security-auditor, and test-engineer delegates in parallel. Returns go or no-go with a rollback plan   |
| `/webperf [url or files]`              | A web app feels slow                   | Starts the web-performance-auditor delegate. A URL gets measured numbers, and source files alone get likely issues              |

Every argument is optional. With no argument, each command works on the current change or the current spec.

## Start from where the work arrives

Most work arrives mid-process, as a PR to review, a ticket on the board, or requirement docs someone else wrote. Join the lifecycle at the phase the work is in, and skip the phases it already passed.

### Review someone else's PR

1. Type `/review PR #123 in a worktree`. The agent reads the PR and runs its tests in a separate worktree, so your branch stays as it is. It lists findings as Critical, Required, Optional, or Nit.
2. If the PR touches auth, data, payments, or a migration, ask "what could PR #123 break" (`blast-radius`) or "interrogate PR #123" (`interrogate`).
3. Pick the verdict. Approve when the change improves the code, even if it is not perfect. Request changes when a Critical or Required finding is open.
4. Say "post it as request changes" or "approve it". The agent shows you the review text and asks before it runs `gh pr review`, because posting sends a message to other people.

### Plan a ticket from the board

First, decide how big the ticket is.

- **One PR with a clear scope.** Skip the spec and the plan. Say "implement #42", or type `/test #42` for a bug.
- **A vague ticket.** Say "interview me about #42" (`interview-me`) until you know what you want. Then treat it as a project.
- **A project.**
   1. Type `/spec #42`, then approve `SPEC.md`.
   2. Type `/plan file the tasks as sub-issues of #42`. The tasks go to the tracker instead of `tasks/todo.md`, and `tasks/plan.md` keeps the design and the risks.
   3. For each sub-issue, say "implement #43", then `/review` and merge. One sub-issue is one PR.

The agent reaches GitHub through `gh`. For Jira or Linear, paste the ticket text after the command.

### Implement a PRD and a TRD

A PRD says what to build and why. A TRD says how. Neither one is a spec, because both leave out the commands, the test strategy, the boundaries, and the places where the two docs disagree.

1. Type `/spec implement docs/prd.md following docs/trd.md`. The agent reads both docs and the code, asks only about what they leave out, and writes `SPEC.md` with the two docs as its sources. A conflict between the docs becomes a blocking open question.
2. Settle the open questions, then approve `SPEC.md`. If the PRD covers several features that can ship separately, the agent proposes a capability map first, and you get one spec per feature.
3. Type `/plan`, or `/plan file the tasks as sub-issues of #42` if the work has an epic.
4. Run `/build` one task at a time, or `/build auto` once you trust the plan. `/build auto` requires `SPEC.md`, so it refuses to start from the PRD and the TRD alone.
5. Run `/review`, then `/ship`.

### Smaller entry points

- **A bug report.** `/test splitCents(100, 7) returns cents that sum to 98`.
- **Code that works but is hard to read.** `/code-simplify src/billing/`, then `/review`.
- **A repo with no written quality bar.** `/constraints`. Before a merge, `/constraints guard` catches skipped tests and new lint suppressions.
- **A slow page.** `/webperf https://staging.example.com/invoices`.
- **A small change.** Skip the commands and ask in plain words, for example "rename `fetchUser` to `loadUser`" or "commit this".

## What's in the repo

- `agent/skills/` holds the skills, and `agent/prompts/` holds the slash commands.
- `agent/principles/` holds the hard rules an agent reads when a principle's `when` line matches its task.
- `agent/SYSTEM.md` and `agent/roles/` make up the system prompt. `agent/instructions/` holds the delegate briefs, such as `code-reviewer.md`.
- `agent/extensions/`, `features/`, and `clients/` hold the TypeScript extensions. `docs/adr/0001-harness-layout.md` explains how the code splits across them.
- `GLOSSARY.md` defines the terms the code uses, such as delegate, serve, watch, and group.
