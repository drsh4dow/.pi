---
description: Execute a unit of work end-to-end, from an approved plan file or inline task.
argument-hint: "<plan file path or task context>"
---
## Task

$ARGUMENTS

If the arguments contain a path to a plan file, that file is your briefing and approved spec: read it fully before anything else. You may have no other context; the plan plus the repo is everything you need.

## Rules

- Reuse cross-repository constructs when possible and be simple.
- Don't create unnecessary helper functions or abstractions. Prefer suckless philosophy (modules should be blunt, local, and easy to follow).
- Prefer code reduction/deletion over adding new code. The final diff should ideally favor more deletion than additions when possible.
- Prefer a red-green-refactor approach when applicable and when it makes sense.
- Don't add tests that just assert constants or things that are obvious.

## Plan fidelity

When working from a plan file:

- The plan is approved. Do not re-litigate its design decisions; implement them.
- Verify before trusting: confirm named files, symbols, and assumptions against the repo. The repo is the source of truth; plans go stale.
- Minor mismatch (renamed file, moved symbol, slightly different signature): adapt, preserve the plan's intent, record the deviation.
- Material mismatch (approach invalid, interface must change, assumption false, scope grows): stop and ask the user. Do not silently redesign.
- Implement exactly the plan's scope. No extras, no gold-plating, nothing the plan doesn't call for.

## Process

### 1. Brief

Read the plan file and any referenced documents fully. Load any relevant skill if it has a minimal chance to be useful for the task, do this before doing anything else. Explore the files the plan names to confirm reality matches before editing. Without a plan file: explore the codebase to understand the relevant files if not already in context; if the task is ambiguous, ask the user to clarify scope before proceeding.

### 2. Implement

Work through the plan in its sequencing, step by step. After each step, confirm the diff still matches the plan's intent before moving on.

### 3. Validate

Load the verification-before-completion skill only in this point, do not load it earlier.
Run the plan's Validation section exactly as written, then the repo feedback loops (linting, type check, tests). Fix any issues.

### 4. Review and beautify

Run a reviewer subagent before summarizing. The reviewer should check for unnecessary complexity, beautiful, simple, and elegant code, it should audit the current code changes. If a plan file exists, pass its path so the reviewer also flags scope creep beyond the plan. Use this output to improve the code implementation. (pass to the reviewer subagent the definition of beautiful code below)

<BeautifulCode>
Beautiful code is code that is readable on a single seam, code that is simple, that doesn't use unnecessary abstractions, getters, setters or scattered constants when they are used a single time. Code that blends perfectly on the current patterns and standards of the repo. Code that produces a git diff with more deletions than additions, this is one of the strongest beauty representations.
</BeautifulCode>

### 5. Present to the user and wait for feedback

Present a summary of the results. If working from a plan, list every deviation from it with its reason — an empty list is the goal. Ask for feedback highlighting the main implementation patterns and offer to either adjust something or commit the changes.

### 6. Commit if user accepts

Once the validation is complete, commit the changes to the codebase explaining the decisions, the why, and any useful context. Don't overstate what was done explicitly, as this can be inferred from the diff.
