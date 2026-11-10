# Owned work survives a reload, a fork opens a new tab, and every other session change stops the work

A pi process's owned work runs in its root's systemd slice, and nothing outside that process records enough to take it over. So the work runs as long as the process stays on its session.

- **Reload** keeps the work. The old load of the owned-work extension freezes its ledger and leaves the state and agent key in a process-global slot (`features/owned-work/handover.ts`). The new load takes them, re-arms deadlines and lets hc's resync settle whatever ended in between. The state is stamped with a hash of `work.ts` and `step.ts`. When a reload changed those files, the new code cannot trust the old layout, so it stops the old work, as `/new` would, and warns.
- **`/fork` and `/clone`** in a herdr-app tab cancel pi's in-place fork. They write the branched session and start it as a new pi in a new tab of the same space, so the source session and its work carry on. Outside herdr-app pi forks in place, after asking.
- **`/new`, `/resume`, an in-place fork and quit** stop the work. The three switches ask first while work runs.

## Considered options

- **Rebuild the ledger from the session's `owned-work` entries.** Rejected. The entries are a log written for display, and they do not record deadlines, a delegate's session folder or the structured outcome of a result a group still holds, so a rebuild would need a full event-sourced entry format to support reload alone.
- **Keep the old runtime alive across the reload.** Rejected. It stays bound to the old load's `pi` object, and edited owned-work code would never take over.
- **A supervisor process that owns the work.** Rejected as far larger than the problem. It would also let work outlive a quit, which nobody asked for.

## Consequences

- Editing `work.ts` or `step.ts` and reloading stops running work, so no load reads state that other code laid out.
- The global slot is read once, by the first session start after the reload, and only when its reason is `reload`. A fork's pi is a new process, so it starts empty.
