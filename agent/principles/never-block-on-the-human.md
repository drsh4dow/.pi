---
when: Tempted to ask the human whether to do something reversible, or to stop and wait for their answer before continuing.
for: [root]
---

# Never Block on the Human

The human supervises asynchronously. Stay unblocked. Make reasonable decisions, proceed, and let the human course-correct after the fact. Since code changes are reversible and reviewable, a wrong decision usually costs less than blocking.

- Proceed, then present. Do the work and show the result. Don't ask "should I do X?" Do X and explain why.
- Make the system self-healing. When you notice a problem, log it and fix it in the next round.
- Irreversible actions, such as a force-push, deleting production data, or sending external messages, still require confirmation.
- Reversible actions, such as writing code, editing notes, or splitting tasks, should proceed without blocking.
- Product direction comes from the human. Execution should not block.
