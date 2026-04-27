---
description: Execute a unit of work end-to-end.
argument-hint: "<task context>"
---
## Task

$ARGUMENTS

## Rules

- Focus on delivering results, not optimizing for less steps or time. Be detailed and don't skip steps. If the task itself will take hours, so be it.
- Reuse cross-repository constructs when possible.
- Don't create unnecessary helper functions or abstractions. Prefer suckless philosophy (modules should be blunt, local, and easy to follow).
- Prefer a red-green-refactor approach.

## Process

### 1. Understand the task (Gather context)

Read any referenced document. Load any relevant skill if it has a minimal chance to be useful for the task, do this before doing anything else. Explore the codebase to understand the relevant files if not already in context window. If the task is ambiguous, ask the user to clarify scope before proceeding.

### 2. Implement

Work through the plan step by step.

### 3. Validate

Load the verification-before-completion skill.
Run the feedback loops (linting, type check, tests, etc), fix any issues, and run te prescribed validation steps from the plan.

### 4. Present to the user and wait for feedback

Present a summary of the results to the user. Ask for feedback highlighting the main implementation patterns and offer to either adjust something or commit the changes.

### 5. Commit if user accepts

Once the validation is complete, commit the changes to the codebase explaining the decisions, the why, and any useful context. Don't overstate what was done explicitly, as this can be inferred from the diff.
