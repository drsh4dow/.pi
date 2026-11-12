---
when: Resuming or taking over a prior agent's in-flight work from a transcript, a delegate's worktree, or a pushed branch.
---

### Session pickup

**You own the resume point. Read the prior trail, don't redo it.**

1. Locate the prior trail. A pi session file under this workspace's folder in `~/.pi/agent/sessions/` (do not glob across `~/.pi/agent/sessions/*/`, that crosses workspace boundaries and reads private chats from unrelated projects), a delegate's worktree, or a pushed branch. Read the metadata overview and last messages first, then scan back for the decision points. Parse a long transcript in a delegate and keep the reduced timeline in the main thread (**principle-guard-the-context-window**). Pick each delegate's model alias and role for the job.
2. Reconstruct operational state. The branch and worktree, what already landed (`git log`, `git diff` against the base), the open steps, the decisions made. The prior trail is authoritative input. Resist the bias to re-derive it.
3. Diff done vs pending. Compare what shipped against what was planned, name the resume point, do not re-run the prior repro or redo completed work. A "let me verify from scratch" pass means you're treating the trail as untrustworthy when it's authoritative.
4. Route the remaining work to the matching playbook and pick the verdict: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or postmortem a failed run. The pickup playbook ends here. The routed playbook owns the rest.
5. Verify the inherited claims against the original goal on the real artifact (**principle-prove-it-works**). A passing prior self-report is not the proof.

**Reply:** where the prior agent stopped, what you inherited vs redid (ideally nothing redone), the resume point, and the outcome.
