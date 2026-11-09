---
when: About to end a session, or starting a fresh one to continue earlier work.
for: [root]
---

# Persist at Session Boundaries

A fresh session is safe at a completed task boundary, not at an arbitrary token count.

- Before leaving the current session, persist: the accepted scope and decisions in the spec or plan; the current task status and the next pending task; the files changed and the working-tree state; the exact verification commands and outcomes; unresolved questions, risks, and required approvals.
- In the fresh session, read the rules, spec, plan, task status, and actual `git status` before acting.
