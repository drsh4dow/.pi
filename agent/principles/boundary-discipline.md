---
when: Wiring validation, error handling, parsing, or a framework adapter, or deciding where a check or a piece of logic belongs.
---

# Boundary Discipline

Place validation, type narrowing, and error handling at system boundaries. Trust internal code unconditionally. Business logic lives in pure functions. The shell is thin and mechanical.

**Why.** Scattered validation is noisy, redundant, and gives a false sense of safety. Keep logic out of framework wiring so it can be tested without the framework.

**The pattern:**

- **At boundaries** such as CLI args, config files, external APIs, and network protocols, validate, return errors, and handle defensively.
- **Inside the system**, use typed data and error propagation, with no re-validation. Trust the types.
- **Across the boundary**, expose domain concepts, not the boundary's private representation. Keep general-purpose mechanism inside and special-purpose policy at the edge.

**Applications.**

Validation and error handling:

- Validate config at parse time (the boundary), not inside business logic.
- Parse raw data into domain types at the boundary.
- Do not re-export transport, storage, framework, or wire types through the public surface.
- Skip redundant nil checks deep in call chains when the boundary already validated.

Code organization:

- Business logic lives in pure functions with no framework dependencies.
- Parse functions are pure transforms from raw bytes to typed state.
- Prompt construction takes structured state in and returns a string.
- Scoring and assessment are pure transforms from state to results.

**The tests:**

- "Is this data crossing a system boundary right now?" If not, validation is redundant.
- "Can this be a pure function that the shell just calls?" If yes, extract it.
