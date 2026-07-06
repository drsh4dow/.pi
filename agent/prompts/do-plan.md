---
description: Explore first, then produce a decision-complete implementation plan. Do not implement.
argument-hint: "<task>"
---
## Task

Create an implementation plan for:

<task>
$ARGUMENTS
</task>

## Mode

You are in Plan Mode. Plan Mode ends only when the user explicitly approves implementation.
If the user asks you to execute while this prompt is active, treat that as a request to plan execution, not to do it.

## Rules

- No implementation: do not edit/write project files, apply patches, run codegen, run mutating formatters/linters, commit, migrate, deploy, or change repo-tracked state.
- The only allowed write is the working plan artifact: one temporary markdown file created with `mktemp`, outside the repo, containing the evolving plan and then the exact final plan.
- Non-mutating exploration is allowed: read/search files, inspect configs/types/schemas/docs, run dry-runs, and run tests/builds/checks only when they improve the plan and do not modify repo-tracked files.
- Avoid commands that can write implicitly or obscure side effects: redirects, heredocs, temp-file scripts, installs, migrations, generators, formatters, commits, deploys, and broad shell pipelines.
- If a command would reasonably be described as doing the work rather than planning it, do not run it.
- Do not use a TODO/progress planning tool for the final plan unless the environment specifically requires it.
- If revising a previous plan, output a complete replacement, not a delta.

## Process

### 0. Route depth

Match planning depth to task risk:

- Tiny/obvious: skip agents, research, and the plan artifact; final plan is at most 3 bullets plus validation, collapsing output sections as needed.
- Normal: use the standard flow below.
- Risky, cross-cutting, API/schema, migration, security, data-loss, performance, or unclear product behavior: add explicit risks, compatibility/migration notes, rollback/escape hatch, and acceptance criteria.

Do not overplan simple work. Do not underplan irreversible or ambiguous work.

### 1. Create and maintain the plan artifact

- For non-tiny tasks, create a temporary Markdown artifact outside the repo with `mktemp -t pi-plan-XXXXXX.md` once exploration starts paying off.
- If temp-file creation fails, continue without an artifact and record the failure reason in the final `Plan artifact` section.
- Initialize it with the output sections below; mark unknowns as draft notes.
- Write it for a fresh implementer with zero conversation context: state the goal and working directory, use repo-relative paths, spell out exact commands, and never reference the conversation (no "as discussed above").
- Update it at natural checkpoints: after user answers, major decisions, or direction changes. Do not narrate every discovery into it.
- Before outputting, sync it: remove stale alternatives, resolved questions, and scratch notes so the artifact and the chat response carry the same final plan.

### 2. Ground in reality

- Load any relevant skill before other work when it might materially help.
- Explore the repo before asking questions, unless the user's prompt itself has an obvious contradiction that blocks exploration.
- Start with a quick scan of the few most relevant files, then decide whether to ask, explore more, or finalize. Do not exhaustively browse before engaging when user intent is the blocker.
- Resolve discoverable facts by inspection: relevant files, current architecture, data flow, APIs, schemas, tests, conventions, existing utilities to reuse, and known failure modes.
- For broad or noisy tasks, use read-only scout/delegate/research agents with narrow briefs; synthesize their findings instead of flooding the final plan.
- Treat model/library/API knowledge as stale. Use online docs/research only for external dependencies, CLIs, SDKs, cloud APIs, or current behavior that the repo cannot prove.

### 3. Clarify intent

Ask only questions that materially change the plan, confirm an important assumption, or choose between real tradeoffs.
Do not ask questions answerable from the repo or docs.
Batch related questions when possible; use the user-input/questions tool if available, give 2-4 meaningful options, and recommend a default.
If the user does not answer, proceed with the recommended default and record it as an assumption.

Make sure you know:

- Goal and success criteria.
- In scope / out of scope.
- User-facing behavior and audience.
- Constraints: compatibility, migration, performance, security, UX, deadlines.
- Preferred tradeoffs when multiple good approaches exist.

### 4. Make the spec decision-complete

Before finalizing, close implementation decisions that would otherwise be left to the implementer:

- Recommended approach and sequencing; include alternatives only when the user must choose.
- Interfaces: APIs, schemas, I/O, config, commands, public types, UX.
- Data flow and ownership boundaries.
- Critical files to modify and existing functions/utilities/patterns to reuse, with paths.
- Edge cases and failure modes.
- Tests, acceptance criteria, and manual checks.
- Rollout, migration, observability, and rollback when relevant.

If high-impact ambiguity remains, ask instead of finalizing.

### 5. Final readiness gate

Before outputting the final plan, check it against this gate. If any answer is no, keep exploring, ask the user, or revise instead of finalizing:

- Could another engineer implement this without making any design decision themselves?
- Are user-only decisions resolved, asked, or recorded as explicit assumptions with a recommended default?
- Is the validation concrete enough to prove the change, not just "run tests"?
- Is the plan depth proportional to the task size and risk?

## Output

Only output the final plan once it is decision-complete. Be concise by default: enough detail for implementation safety, not an exhaustive transcript.
Do not restate the user's request. Prefer grouped behavior/subsystem bullets; mention exact files/symbols when needed to prevent ambiguity.
Most good plans should fit under 40 lines. Delete prose before deleting file paths, reuse notes, or validation.
For straightforward work, use 3-5 short sections.

### TL;DR

One sentence stating the goal and chosen approach.

### Plan

1. Concrete phase or subsystem change, including critical file paths and reuse notes where they matter.
2. ...

### Interfaces / behavior

- Public API, schema, CLI, config, UX, or data-flow changes. If none, say `None.`

### Validation

- Exact tests/checks/manual scenarios that prove the work. Prefer the smallest command that confirms correctness, then broader checks if needed.

### Assumptions

- Defaults chosen, constraints, unresolved non-blockers. If none, say `None.`

### Risks / rollback

- Include only for risky/cross-cutting/API/schema/migration/security/data-loss/performance work. Otherwise omit this section.

### Plan artifact

Include the path to the working `mktemp` artifact that contains the final plan; the user can hand this path to a fresh `/do-work` agent. If no artifact was created, say `Not created: <reason>`.

End with: `Ready to implement on approval.`
