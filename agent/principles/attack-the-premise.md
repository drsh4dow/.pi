---
when: Two or more fixes that share one premise have failed the same gate, or you are about to try another fix that rests on the same belief.
---

# Attack the Premise

When two or more fixes that share one premise have failed the same gate, suspect the premise, not the fixes.

**Why.** Each failed fix is evidence against the belief it assumed. A third fix on the same premise spends effort where the evidence already says the cause is not.

**Pattern:**

- **Write the premise down.** The premise is the one sentence that every failed fix assumed.
- **Test the premise before the next fix.** Find an observation that would come out differently if the premise were false, and make it. Look at how the failures are distributed, not only at how large they are. Make the check rerunnable per principle-build-the-lever.
- **Follow the evidence.** If it contradicts the premise, the cause is elsewhere. Look for what the failures have in common that the premise did not predict. If it confirms the premise, ask the next "why" per principle-fix-root-causes. The earlier fixes may have treated a consequence instead of the cause.
- **Remove the condition instead of compensating for it**, per principle-laziness-protocol. If the evidence shows that one part always lands on the losing side, change what puts it there. A mechanism that cleans up after it leaves the cause in place and adds work on every run.

**Stop.** Do not start the next fix before the premise is written down and tested.

This principle is distinct from principle-redesign-from-first-principles, which rebuilds a design around a new requirement. This one questions a fact the current design assumes.
