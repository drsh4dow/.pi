---
name: how
description: 'Use for "how does X work", code walkthroughs before changing something, and placement questions ("where should this live", "is this the right layer"). Explains subsystem architecture and runtime flow. Use why for motivation.'
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. Start one explainer delegate that explores and explains in one pass, with `instructionsFile: ~/.pi/agent/skills/how/references/explainer-prompt.md` and the question as its task message. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Start one explorer delegate per angle, each with `instructionsFile: ~/.pi/agent/skills/how/references/explorer-prompt.md` and the question and its angle as its task message. Group them with mode `all`.

## 3. Synthesize (complex only)

Once all explorers have returned, start one explainer delegate with `instructionsFile: ~/.pi/agent/skills/how/references/explainer-prompt.md` and the question and every explorer's findings as its task message.

## 4. Present

Present the explainer's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
