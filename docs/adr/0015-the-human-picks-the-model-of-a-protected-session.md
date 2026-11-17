---
status: accepted
---

# The human picks the model of a protected session

ADR 0012 listed model switches among the paths that must stay inside the BAA boundary, so `selection.ts` put every switch away from `phi/auto` or `ent` back on a protected model, and did the same when a session resumed on a personal one. In practice it locked the human out of their own model picker: each `/model` pick in an `ent` session was reverted with a warning to start a new session. The human ruled that the choice of model is theirs to make, and that the harness must not overrule it.

So the harness no longer restores a protected model on `model_select` or `session_start`. The router still guards what the agent does on its own: delegates, codemode scripts, compaction and failover. A switch is the human's act, so the router follows the model they selected.

## Considered options

- **Keep the revert, and add an override command.** Rejected. It keeps the lock as the default, and the human asked for it gone.
- **Allow the switch, and warn on it.** Rejected. The human made the switch, so a warning repeats what they already know.

## Consequences

- A switch from an `ent` session to a personal account sends the whole conversation to that account on the next request.
- A switch from `phi/auto` to a raw personal Claude model still passes the border, which stubs sealed and unjudged parts. A switch to another provider carries everything.
- When pi cannot restore a session's saved model and falls back to another, the session stays on the fallback.
- Delegates and codemode guards follow the selected model, so after a switch to a personal model they treat the session as unprotected.
