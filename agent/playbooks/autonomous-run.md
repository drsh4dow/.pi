---
when: A long task to drive to completion without stopping ("run until done", "don't stop until X", "keep going until X").
---

### Autonomous run

**You own the exit condition. Define done, then drive to it without stopping.**

1. State the exit condition as a checkable predicate before the first iteration (tests green, repro fixed, all N PRs merged, pixel-diff zero).
2. Pick the wake mechanism using `watch`. An event to watch (CI, a merge, a ref advancing) gets a `watch` on a command that exits on the event, such as `gh pr checks <number> --watch`, with a long `watch` on `sleep <seconds>` as a heartbeat fallback. No event gets a fixed-interval heartbeat, a `watch` on `sleep <seconds>` sized to when the result is worth re-checking. Pick each delegate's model alias and role for the job.
3. Each iteration makes the smallest change the evidence justifies, verifies it against the predicate, commits if it advanced, discards changes that didn't help. Belt-and-suspenders that "might help" gets reverted, not left to ride.
   Sequence the work via **principle-sequence-verifiable-units**, verifying each unit before the next instead of batching checks at the end.
4. Mid-run discoveries that support the goal are yours. Address broken skills, related bugs, flaky verifiers, review noise, tooling failures, and fixable drift yourself. Any other finding is a known limit. Put out-of-band fixes in their own PR. Do not park reversible work for the human or end the turn to ask. Surface only irreversible actions, genuine product or preference calls no experiment can settle, or a real dead end. Keep the predicate as the main drive, and return to it after each side fix.
5. Checkpoint every iteration via the **show-me-your-work** skill, a row for what changed and whether the predicate moved.
6. Stop when the predicate is met. A plateau is not a stop, so keep going and pivot your approach to push past it. Surface a genuine dead end rather than spinning, and never relax the predicate to declare victory.

**Reply:** the exit condition, iterations run, what landed, what was discarded, final predicate state.
