---
when: Before a step that brings many files, a long file, or large output into your context, or when planning work across many delegates.
---

# Guard the Context Window

Route bulk to delegates; keep summaries in the main thread, not raw payloads. When you cannot start delegates, read only the part of a file you need and filter command output before it reaches you.

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**

- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
