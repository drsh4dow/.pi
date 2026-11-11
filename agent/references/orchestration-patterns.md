# Orchestration patterns

How an agent splits work with its delegates in this harness. Read this before adding a slash command that starts several delegates, or a new persona.

The governing rule: **the agent that owns a task leads it.** It settles what the task is, hands out the parts that fit a delegate, checks what comes back, and reports. A persona gives one perspective on one artifact and starts no other persona.

The `delegate` tool's guidelines say when to delegate. This file maps the shapes they produce onto pi.

## Shapes

### 1. Inline

The agent does the work itself: a handful of tool calls, or work that needs context no task message can carry, such as judgment built up with the human.

### 2. Reading delegate

```
agent → delegate (reads 50 files) → answer and evidence locations → agent continues
```

For an answer much smaller than its reading: tracing code across files, finding every call site, summarizing 30 ADRs, going through logs or a transcript. The agent reads itself only what it will edit or quote.

### 3. Parallel fan-out with merge

```
                    ┌─→ code-reviewer    ─┐
/ship → fan out  ───┼─→ security-auditor ─┤→ merge → go or no-go, with a rollback plan
                    └─→ test-engineer    ─┘
```

For independent parts: no two write the same file, and none needs another's result. Start every `delegate` in one turn, then gather them with `group` (`mode: "all"` for one wake with every result). Delegates cannot message each other, so the starting agent merges and compares; ask each for an answer short enough that all of them fit.

### 4. Owner

```
root → owner (builds, verifies and reports one slice) → the owner's own delegates
```

One owner per implementation slice, in its own git worktree (`cwd`). Coupled code, such as one feature or one migration, stays with one owner, which may fan out inside its slice. Its task message names the user's goal, the spec or plan path, and what counts as done, and the root checks its result against the real artifact.

## What pi enforces

- **Three levels.** The root is level 1, its delegates are level 2, and theirs are level 3. An agent at the last level has no `delegate` tool.
- **One message each way.** A delegate starts in a fresh context, gets one task message, cannot ask questions, and answers once, with its last message.
- **Personas are instructions files** in `~/.pi/agent/instructions/`. Start one with `instructionsFile`. `GLOSSARY.md` defines the frontmatter under **Profile**. A persona's file carries no skill list, so name a skill it depends on in its body.

Nothing in pi stops a persona from starting another persona. The "Do not invoke from another persona" line in each persona's file does.

## Delegate setups

Check these before defining a persona:

| Setup                                                                        | Purpose                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------- |
| `delegate` with `model: "scout"`                                             | Mechanical codebase search and aggregation    |
| `delegate` with `instructionsFile: "~/.pi/agent/instructions/researcher.md"` | Read-only web research on one sub-question    |
| plain `delegate`                                                             | An owner, or any task that explores and edits |

## Anti-patterns

- **Router.** A delegate whose only job is to pick the next delegate. Every level either does work or makes a decision the level above could not.
- **Persona that calls a persona.** A `code-reviewer` that starts a `security-auditor`. Each persona gives one perspective, and the summary one passes to the next loses what the next needs. The persona recommends the follow-up in its report, and the agent that started it runs the second pass.
- **Relay.** An agent that passes a delegate's answer on unread, or a task message that paraphrases a spec instead of naming its path. Each hop loses detail. Check the answer against the artifact, and point at files.
- **Split owners on coupled code.** Two owners that edit the same files. Give coupled work one owner.
