---
when: Your context is filling up or about to, through large outputs, long files, repeated reads, or planning work across many delegates.
---

# Guard the Context Window

**Why.** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**

- **Route bulk away from your context.** When you can start delegates, hand them large outputs, long files, and repeated reads, and keep only their summaries. When you cannot, read only the part of a file you need and filter command output before it reaches you.
- **Keep summaries, not raw payloads.** What stays in your context is the conclusion and the evidence it rests on.
- **Size phases and cap scope.** Limit files per phase, set turn budgets, and account for what each mechanism costs in context.
