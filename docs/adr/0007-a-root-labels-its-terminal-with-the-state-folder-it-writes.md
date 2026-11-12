# A root labels its terminal with the state folder it writes

herdr-app's Trace and Actions panels show the focused agent's `TODO.md`, `decisions.tsv` and `USER_ACTION_ITEMS.md`. Those files live in the work's state folder, and nothing outside the agent knows which folder that is.

So the state-folder extension (`features/state-folder/`) watches the session's own tool calls. Before a call runs, it fingerprints each state folder the call's arguments name: the names, sizes and modification times of the folder's own entries. After the call, a folder whose fingerprint changed is the one the session wrote to. It writes that path to the `pi.state` label on the agent's own terminal, and records it as a session entry so `/resume`, `/reload` and `/tree` restore it. The panels (`herdr/mods/ow-work/`) walk from the focused terminal up through `parent` and read the highest label, so a focused delegate shows its root's work. Delegates do not load the extension.

## Considered options

- **Parse the call for a write.** Rejected. A `write` or `edit` names its path, but a bash command or a codemode script names folders it only reads too, and telling `cat` from `log.sh` means parsing shell and JavaScript.
- **A tool or a pointer file the agent sets.** Rejected. It is one more instruction the agent can forget, and the folder it names can go stale.
- **The panels watch the folder with `watchFolder`.** Rejected. A state folder can hold a git worktree, and a recursive watch of that is noisy or refused. The panels read their files every two seconds while on screen and not at all while hidden.

## Consequences

- A call that writes through a path held in a shell variable, such as `$DIR/STATE.md`, names no folder and does not move the label.
- Another process writing a folder while a call that only reads it runs moves the label to that folder.
- Editing an existing file in a subfolder, such as `docs/plan.md`, changes no entry of the folder itself and does not count.
- The Actions button reads `USER_ACTION_ITEMS.md` every three seconds, since the top bar is always on screen.
