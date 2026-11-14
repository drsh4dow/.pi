---
status: proposed
---

# Every owner can delegate, and an owner at the last level starts leaves only

ADR 0006 made the role decide whether an agent delegates, with one exception: "An owner has the `delegate` tool unless it sits at the last level; a leaf never has it." Two 24-hour sessions of 2026-11, with 507 delegates between them, showed what that exception costs. 383 level-3 sessions could not delegate, and in one of the two, 129 of 149 code-editing sessions ran there. `architect`, `arena` and `interrogate` ran 0 times in 93 code-and-PR sessions. One stack's last-level owners launched reviewers at least 16 times as untracked `pi -p` subprocesses, so their cost and results never reached the ledger.

So every owner has the `delegate` tool. Level 3 stays the last level an owner can hold. An owner there may start leaves only, and they run at level 4. A leaf never delegates, so no chain grows past level 4. Role is capability again, and the existing `for` filter shows delegate-only skills to exactly the agents that can use them.

An owner at the last level may also be handed its design to choose. It then runs the design work, such as `architect` and `arena`, with leaves at level 4. Holding the design back at that level would keep most of the gap this record closes, since most of one session's code-editing sessions ran there.

This supersedes two parts of ADR 0006: the sentence quoted above, and its consequence "An owner at the last level runs its playbooks without delegates. Its role file tells it to do a delegating step itself and say so." The rest of ADR 0006 stands.

## Considered options

- **Route a last-level owner's review through its parent.** The owner ends, the parent runs the reviewer, then continues the owner. Rejected as the main path. Every review round would pass through the parent's context, and a last-level owner still could not run an arena. A parent reads a child's answer only when the child's terminal ends, so the owner has no way to ask mid-run.
- **A `needs: [delegate]` frontmatter key that hides delegate-only skills from agents without the tool.** Rejected. It patches the gap between role and capability instead of removing it.
- **Keep the rule and forbid `pi -p` in the prompt.** Rejected. In both sessions a rule held when the harness ran it and failed when an agent had to remember it, and no harness code sees a `pi -p` launch.

## Consequences

- Agents run at level 4 for the first time, so every check that bounds the level moves to 4. Process priority asks `choom` for 500 per level below the root, and level 3's 1000 is already the kernel maximum (inferred from the grounding, not run), so level 4 needs its own value.
- `arena`, `architect`, `interrogate`, `swarm`, `how` and `no-comments` name `root` and `owner` in their `for`, so every owner's skills section lists them and a leaf's leaves them out.
- A level-3 owner's reviewers and arena runners are tracked delegates. Their spend reaches the cost label, and herdr-app shows them under their owner.
