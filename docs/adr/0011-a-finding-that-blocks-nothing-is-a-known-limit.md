---
status: proposed
---

# A finding that blocks nothing is a known limit, and a pull request gets two repair rounds

Agents finishing a task kept finding edge cases, and each fix or ticket made more work, so the task never reached its goal. In the human's words, "there will always be edge cases and your nature is to try fix them all, but some edge cases are just not worth it". The playbooks caused it. pstack, the upstream they come from, bounds review to one full swarm and blocks a pull request only for a bug a user would hit, a failed gate, or a wrong shipped doc. But its autopilot sends "everything else" to a follow-up, and its autonomous run makes "orphaned follow-ups" the agent's own work. The Definition of Done asked for every edge case handled. In one six-round review of a harness change, a narrower blocking bar would have saved no whole round. Four of the rounds repaired the same boundary, and a redesign in the fifth ended them.

So the harness chose four rules:

- A finding that fails no acceptance criterion, gate, or doc line, and that no user would hit in good faith, is a known limit. It gets one line in the pull request's Scope, no fix, and no ticket unless it breaks the spec or the human asks. The shared prompt layer says this once, and the playbooks use the term.
- After its full review, a pull request gets two repair rounds. When the second fails, the pull request is reported blocked with what still fails, and its design is decided again before a third fix. The playbooks that loop on fixes point at the attack-the-premise principle at that step. A wake that stops the loop on a third failed verdict is separate work.
- A ticket names its non-goals, and its checks and non-goals stay as written once work starts.
- The feature playbook runs one simplify-and-reduce pass that deletes what no acceptance criterion needs, and the pull request reports the diff size before and after it.

## Considered options

- **A follow-up quota.** Rejected. A cap on open work does not limit tickets nobody started, and until it fills, each finding still becomes work.
- **A severity scale that blocks above a level.** Rejected. The blocking bar already exists, and the six-round review shows a stricter filter would have saved no round. A scale also asks the agent that found a bug to grade it.
- **A ticket for every finding,** as pstack's follow-up rule does. Rejected. Each ticket is owned work, so this is the loop the rules remove.

## Consequences

- In a project where the team wants follow-up tickets, agents stop filing them unless asked.
- The reflect skill files a Backlog item only after the human approves it, as it already did for an Accepted edit.
