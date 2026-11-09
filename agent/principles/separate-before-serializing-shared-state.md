---
when: Concurrent actors such as delegates, processes, or workers might write the same file, branch, key, or state object.
---

# Separate Before Serializing Shared State

When concurrent actors might share mutable state, first ask whether they need the same mutable object. If not, eliminate the sharing. When sharing is real, enforce serialization structurally, with lockfiles, sequential phases, or exclusive ownership. Instructions and conventions are not concurrency control.

**Why.** Concurrent writes to shared state create race conditions that are intermittent, hard to reproduce, and expensive to debug.

**Pattern:**

1. **Identify shared mutable state**, such as files both read and write, branches both push to, and APIs both define and consume.
2. **By default, eliminate the shared write target.** Ask whether these actors need one canonical object or are publishing independent facts. Give each actor its own file, key, branch, or state directory, and merge only at the read or reporting boundary. Two workers writing their own `lastX` field into one `state.json` is still shared mutation. `indexer-state.json` plus `metrics-state.json` is not.
3. **Only when one shared write target is a real invariant, serialize access structurally**, with lockfiles, sequential phases, a single-writer actor, or atomic compare-and-swap. Treat "we need a lock" as a design smell to check, not as the default answer.
