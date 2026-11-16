---
name: how
description: Asked how something works, for a code walkthrough before a change, or where code should live. `why` covers motivation.
for: [root, owner]
---

# How

Explore the codebase to answer "how does X work?" questions.

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

When one or two files you can name hold the answer, read them and answer yourself.

## 1. Explain

Start one delegate with `instructionsFile: ~/.pi/agent/skills/how/references/explainer-prompt.md` that explores and explains in one pass. Give it the user's question as its task message.

## 2. Present

Present the delegate's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.
