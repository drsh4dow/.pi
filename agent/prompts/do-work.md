---
description: Execute a unit of work end-to-end.
argument-hint: "<task context>"
---
## Task

$ARGUMENTS

## Rules

- Reuse cross-repository constructs when possible and be simple.
- Don't create unnecessary helper functions or abstractions. Prefer suckless philosophy (modules should be blunt, local, and easy to follow).
- Prefer code reduction/deletion over adding new code. The final diff should ideally favor more deletion than additions when possible.
- Prefer a red-green-refactor approach when applicable and when it makes sense.
- Don't add tests that just assert constants or things that are obvious.

## Process

### 1. Understand the task (Gather context)

Read any referenced document. Load any relevant skill if it has a minimal chance to be useful for the task, do this before doing anything else. Explore the codebase to understand the relevant files if not already in context window. If the task is ambiguous, ask the user to clarify scope before proceeding.

### 2. Implement

Work through the plan step by step.

### 3. Validate

Load the verification-before-completion skill only in this point, do not load it earlier.
Run the feedback loops (linting, type check, tests, etc), fix any issues, and run te prescribed validation steps from the plan.

### 4. Review and beautify

Run a reviewer subagent before summarizing. The reviewer should check for unnecessary complexity, beautiful, simple, and elegant code, it should audit the current code changes. use this output to improve the code implementation. (pass to the reviewer subagent the definition of beautiful code below)

<BeautifulCode>
Beautiful code is code that is readable on a single seam, code that is simple, that doesn't use unnecessary abstractions, getters, setters or scattered constants when they are used a single time. Code that blends perfectly on the current patterns and standards of the repo. Code that produces a git diff with more deletions than additions, this is one of the strongest beauty representations.
</BeautifulCode>

### 5. Present to the user and wait for feedback

Present a summary of the results to the user. Ask for feedback highlighting the main implementation patterns and offer to either adjust something or commit the changes.

### 6. Commit if user accepts

Once the validation is complete, commit the changes to the codebase explaining the decisions, the why, and any useful context. Don't overstate what was done explicitly, as this can be inferred from the diff.
