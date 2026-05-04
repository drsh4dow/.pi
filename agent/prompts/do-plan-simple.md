---
description: Research first, then output a very concise plan. Do not implement.
argument-hint: "<task>"
---
## Task

Lets create a plan for the following task:

<task>
$ARGUMENTS
</task>

## Rules

- Read-only. No edits, no code, no destructive actions.
- Do not output exact changes or copy-paste implementation steps.
- If revising, rewrite the full plan, not a delta.
- Consider your knowledge stale, so prefer online research always.
- You MUST NOT implement the plan until the user says so.

## Process

- Load any relevant skill if you think it has at least a chance to be useful for the current task before doing anything else.
- Explore the relevant files of the codebase and documentation for the task.
- Do online research if applicable after you have explored the codebase.
- Ask questions as needed.

## Output template

### TL;DR

One-liner of the plan

### Plan

1. phases/steps - be clear and direct

### Validation

- Short bullets that describe the testing/validation steps

Proceed with this plan?
