---
when: Multi-step work such as sweeps, migrations, or runs of similar edits, and deciding how to order commits or PRs.
---

# Sequence Work into Verifiable Units

Order work as a sequence of small units, each ending in a state you can check, and don't advance until the current one is green.

**Why.** A break caught at the unit that caused it is cheap to localize. A break caught after a batch is buried, and you have already built further on a broken base. Sequencing those same units into a delivery a reviewer can replay turns "trust me" into "watch it go red, then green."

**Execution.** In a sweep, migration, or any run of similar edits, verify each change before starting the next. Each unit is a before and after bracket. Start from a known-good state, make one change, run the check, then proceed. Rebase onto a clean trunk first so every check measures against the real baseline. When a script does the edits, the per-unit check is nearly free. Run it anyway.

**Delivery.** Stack commits and PRs in the order that proves the work. The canonical shape is the failing test first, marked expected-to-fail (Bun's `test.failing`) so every commit passes the checks, then the fix that unmarks it. Other story orders are a subtraction before the reshape, a baseline capture before the treatment, and the scaffold before the feature. Each commit lands on its own and the sequence reads as an argument.
