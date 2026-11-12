---
when: About to end a session, or starting a fresh one to continue earlier work.
for: [root]
---

# Persist at Session Boundaries

A fresh session is safe at a completed task boundary, not at an arbitrary token count.

- Before leaving the current session, persist in the state folder, `~/.local/state/pi-agent/<project>/<work>/`. `STATE.md` holds the destination and the human's standing instructions in their words, the accepted scope, the current task status and the next pending task, the files changed and the working-tree state, the exact verification commands and outcomes, and unresolved questions and risks. `TODO.md` holds the playbook steps, done, skipped and open. `decisions.tsv` holds the decisions. `USER_ACTION_ITEMS.md` holds the approvals and calls that wait on the human.
- In the fresh session, read the rules, the state folder's four files, and actual `git status` before acting.
