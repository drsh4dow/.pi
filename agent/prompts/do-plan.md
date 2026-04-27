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
- Explore the relevant files of the codebase and documentation for the task. If the repository is huge use the `scout` subagent to optimize which files to focus on.
- Do online research if applicable after you have explored the codebase.
- Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer. Ask the questions one batch at a time grouped by topic. Use the ask questions tool. If a question can be answered by exploring the codebase, explore the codebase instead. Repeat the process until you reach a shared understanding and then proceed to output the plan.

## Output template

### TL;DR

One-liner of the plan

### Plan

1. phases/steps - be clear and direct

### Validation

- Short bullets that describe the testing/validation steps

Proceed with this plan?
