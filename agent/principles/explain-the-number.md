---
when: Before you measure, and before you trust, report, or act on a number you measured, such as a speedup, regression, throughput, latency, or eval result.
---

# Explain the Number

Find what limits the number, and rule out that it measured something other than the work you think.

- **Write the decision before you run.** Name the result that would change a decision, and the noise floor. Stop when the run-to-run spread is larger than the effect.
- **Ask "why not double?"** Name the resource or code path that bounds the result, such as a core, a lock, the disk, the network, or the load generator itself. Get it from a profile or from system counters taken during a run, then map it to source. A guess from reading the code is not a limiter. If you cannot say why the number is not twice as good, you do not know what you measured.
- **List what else the number could be measuring, and rule out each one with evidence.** The usual suspects are errors, skipped or cached work, code that never ran, an untuned side (one left on default settings), noise, and a piece too small to matter end to end.
- **Keep the evidence with the number.** Put the run count, the spread, and the limiter in the notes or a linked artifact.

For an eval result, ask the same of the trials. Did every run do the task? Does the gap hold across trials and models? Does the scenario matter?

You skipped this when a run started without the result that would change a decision, when the evidence behind a number has no run count, no spread, or no named limiter, or when the claimed time saved is larger than the whole time the changed piece took.
