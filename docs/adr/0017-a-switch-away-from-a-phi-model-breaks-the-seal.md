---
status: accepted
---

# A switch away from a phi model breaks the seal

ADR 0015 let the human switch a protected session to any model, but the border kept guarding a process whose branch had ever selected `phi/auto`. After a switch to a raw personal model, the border still stubbed sealed and unjudged parts and refused a request whose tool list never cleared. No router ran on the new selection to clear anything, so the session stopped with `phi border refused: tools-not-cleared`. The human ruled that breaking the seal is their choice, and that the harness must not enforce it.

So the border protects a process only while its selection is `phi/auto`. `session_start` and `model_select` set the scope from the selected model alone. A switch to any other model sends the whole conversation, sealed messages included, to that model's provider. A switch back to `phi/auto` protects the process again.

## Considered options

- **Keep the latch, and add a command that lifts it.** Rejected. The human asked for no enforcement, and a command keeps the block as the default.
- **Keep the latch only for delegates.** Rejected. A parent the human moved off `phi/auto` is unprotected, so its delegates follow the table as in any open session.

## Consequences

- This replaces the ADR 0015 consequence that a switch to a raw personal Claude model still passes the border.
- A resumed session is protected only when it resumes on `phi/auto`.
- After a switch back to `phi/auto`, replies a personal account wrote during the unprotected stretch still skip the judge, as every personal reply does. They read content that was not sealed from them.
