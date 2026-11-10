# pi harness

My coding harness for [pi](https://github.com/earendil-works/pi). `AGENTS.md` holds the rules for working in this repo.

## Prompts are for you, skills are for the agent

A skill in `agent/skills/` describes how to do one kind of work. The agent reads the skill descriptions and loads a skill when your request matches one. You don't name it. A bug report loads `test-driven-development`, and "grill me" loads `grilling`. Skills with `user-invocable: false` stay out of the `/` menu. To force one of those skills, type `/skill:<name>` in full.

A prompt in `agent/prompts/` is a command you type to pick the lifecycle phase. Each prompt loads its skills and stops at a fixed point, so you check the result before the next phase. `/ship` and `/webperf` also start reviewer delegates, which a plain request doesn't do.

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

Most work arrives mid-process: a PR to review, a ticket on the board, or requirement docs someone else wrote. Join the lifecycle at the phase the work is in. Skip the phases it already passed.

### Review someone else's PR

1. Type `/review PR #123 in a worktree`. The agent reads the PR, runs its tests in a separate worktree so your branch stays as it is, and lists findings as Critical, Required, Optional, or Nit.
2. If the PR touches auth, data, payments, or a migration, ask "what could PR #123 break" (`blast-radius`) or "interrogate PR #123" (`interrogate`).
3. Pick the verdict. Approve when the change improves the code even if it is not perfect. Request changes when a Critical or Required finding is open.
4. Say "post it as request changes" or "approve it". The agent shows you the review text and asks before it runs `gh pr review`, because posting is a message to other people.

### Plan a ticket from the board

First decide how big the ticket is.

- **One PR, clear scope:** skip the spec and the plan. Say "implement #42", or type `/test #42` for a bug.
- **Vague:** say "interview me about #42" (`interview-me`) until you know what you want. Then treat it as a project.
- **A project:**
   1. `/spec #42`. Approve `SPEC.md`.
   2. `/plan file the tasks as sub-issues of #42`. The tasks go to the tracker instead of `tasks/todo.md`, and `tasks/plan.md` keeps the design and the risks.
   3. For each sub-issue, say "implement #43", then `/review` and merge. One sub-issue is one PR.

The agent reaches GitHub through `gh`. For Jira or Linear, paste the ticket text after the command.

### Implement a PRD and a TRD

A PRD says what to build and why. A TRD says how. Neither one is a spec: they leave out the commands, the test strategy, the boundaries, and the places where the two docs disagree.

1. `/spec implement docs/prd.md following docs/trd.md`. The agent reads both docs and the code, asks only about what they leave out, and writes `SPEC.md` with the two docs as its sources. A conflict between the docs becomes a blocking open question.
2. Settle the open questions, then approve `SPEC.md`. If the PRD covers several features that can ship apart, the agent proposes a capability map first, and you get one spec per feature.
3. `/plan`, or `/plan file the tasks as sub-issues of #42` if the work has an epic.
4. `/build` one task at a time, or `/build auto` once you trust the plan. `/build auto` requires `SPEC.md`, so it refuses to start from the PRD and the TRD alone.
5. `/review`, then `/ship`.

### Smaller entry points

- **A bug report:** `/test splitCents(100, 7) returns cents that sum to 98`.
- **Code that works but is hard to read:** `/code-simplify src/billing/`, then `/review`.
- **A repo with no written quality bar:** `/constraints`. Before a merge, `/constraints guard` catches skipped tests and new lint suppressions.
- **A slow page:** `/webperf https://staging.example.com/invoices`.
- **A small change:** skip the commands. Ask in plain words, for example "rename `fetchUser` to `loadUser`" or "commit this".
