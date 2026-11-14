# Three roles: root, owner and leaf

Superseded in part by ADR 0008, which lets an owner at the last level start leaves.

Every agent has one of three roles. The **root** is the pi at the human's terminal. An **owner** is a delegate handed one slice to build, verify, commit and report on; it may run a playbook and start delegates of its own. A **leaf** is a delegate handed one bounded task, such as a search, a review, a verification lane or a scoped edit; it never delegates and runs no playbook. The roles follow pstack's topology: the chat the human talks to, the agent that carries one PR, and the helper that does one piece of it.

The parent picks a delegate's role, in the `delegate` call's `role` or in the `role` of the instructions file's profile. The call wins, as it does for `model`. A call that names neither fails before anything starts, and the error says what each role is for, so the choice is never a silent default. The child reads its role from `PI_OWNED_WORK_ROLE` beside its level, and the prompt feature builds its prompt from `agent/roles/<role>.md`.

The role decides what the agent gets. An owner has the `delegate` tool unless it sits at the last level; a leaf never has it. A pi that a serve or watch starts is a leaf at the last level. A playbook without `for` fits the root and owners, so a leaf's prompt lists no playbook unless one names it; a skill and a principle without `for` fit every role. The level still caps how deep a chain goes.

## Considered options

- **Role by level: level 2 owns, level 3 is a leaf.** Rejected. A level-2 reviewer and a level-2 slice owner need different tools and different rules, and the root starts both. An owner that wants a reviewer of its own would get one at level 3 only by accident of depth.
- **One delegate role, with per-call flags such as `canDelegate` and `playbooks`.** Rejected. The flags would hand out a tool apart from the role text that says how to use it, and a call could build combinations no role file describes, such as an agent that has the `delegate` tool and a role text that says it starts no delegates.
- **Role by the parent's call, with no default.** Chosen. The parent knows whether it hands off a slice or a lookup, and the instructions file knows what its persona is for, so the profile carries the role for the reviewers, researchers and judges the skills name, and the call carries it everywhere else.

## Consequences

- Each `delegate` call, or the instructions file it names, must say `owner` or `leaf`. A call written before this change fails with an error that says which to pick, rather than starting a delegate with the wrong tools.
- A leaf's prompt is smaller than an owner's: no delegation rules and no playbooks list. Measured with `bun run prompts` on the change's own worktree: root 38,344 bytes, a level-2 owner 29,275, a level-2 leaf 22,151.
- `for: [delegate]` no longer parses. A prompt file names `root`, `owner` or `leaf`.
- An owner at the last level runs its playbooks without delegates. Its role file tells it to do a delegating step itself and say so.
