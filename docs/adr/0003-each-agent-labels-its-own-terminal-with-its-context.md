# Each pi agent labels its own terminal with the guides in its context

herdr-app's Skills panel shows which skills and principles each agent's model sees now, and it has to follow `/tree` and compaction. A herdr-app mod can read files and terminal labels, but the session file records no move of its leaf, so a mod reading it cannot see a `/tree` jump until the next message lands.

So pi computes the set and herdr-app only draws it. The loaded extension builds the set from pi's session projection, which already applies the branch, the latest compaction and context edits. It writes the result as JSON to the `pi.context` label on the agent's own hc terminal (`HC_TERMINAL_ID`) after each turn, `/tree` move and compaction, and clears it when the session ends. The panel reads `terminals()`, takes the focused terminal and its live descendants through `parent`, and shows every one that carries the label.

A guide counts as loaded when its marking lines appear in text the model sees, not when a call named its path. Over the 8 sessions saved after the guides' last edit, both readings agreed on 92 guides. Text matching alone found 14 more, all real: reads of a worktree's copy and reads by relative path. Path matching alone found one, a `grep` that named a skill file and loaded none of it. `bun tools/loaded/replay.ts <since>` reruns the comparison.

## Considered options

- **The mod parses session files.** Rejected. It cannot see `/tree` moves, would duplicate pi's compaction and context-edit rules in JavaScript, and would need to map each terminal to its session file.
- **One shared file that every agent writes.** Rejected. Concurrent writers need locking, and a crashed agent leaves stale rows. A label goes away with its terminal.
- **Track loads as add and remove events.** Rejected. `/tree`, compaction, context edits and `/resume` would each need their own removal rule. Recomputing from the projection needs none.

## Consequences

- A label with four guides is 633 characters. All 90 guides would be about 11,000, and a 20,000-character label was checked to round-trip through hc.
- Guide files are read once per session start. A guide edited after that no longer matches text loaded before the edit until `/reload`.
- An agent other than pi, or a pi outside herdr-core, has no label, and the panel says so.
