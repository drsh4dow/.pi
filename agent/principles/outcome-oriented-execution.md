---
when: Planning or running a rewrite or migration with explicit phase boundaries, or tempted to write compatibility code only to keep an intermediate state working.
---

# Outcome-Oriented Execution

Optimize for the intended, verifiable end state rather than preserving smooth intermediate states.

**Why:** Keeping every intermediate step fully stable often creates temporary compatibility code that becomes long-lived debt. Converge on the target architecture and prove correctness at explicit verification boundaries.

**Core rule:**

- Prioritize end-state integrity over transitional stability
- Intermediate breakage is acceptable inside a phase when it is planned, scoped, and reversible. Commit at the phase boundary, where the checks pass.

**Guardrails:**

- Use this for planned rewrites and migrations with explicit phase boundaries
- Declare where temporary breakage is acceptable
- Keep high-signal checks for actively touched areas while migrating
- Require full static and runtime verification at plan completion
