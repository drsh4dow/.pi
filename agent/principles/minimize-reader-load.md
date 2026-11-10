---
when: Writing, reviewing, or reshaping code that is hard to trace, or about to add a layer, wrapper, adapter, or piece of state.
---

# Minimize Reader Load

Maintainability is the work a reader must do to understand code. Track two axes. **Layers to trace** are the indirections between the question and the answer. **State to hold** is the hidden or mutable context the reader must keep in their head. LOC, cyclomatic complexity, and "clean architecture" are proxies. Reader load is the thing that matters. The two axes are independent. A flat file with 50 globals can be as hard to reason about as a 6-layer adapter stack. Guard both. A reader's working memory is finite.

- **Collapse layers** that cost more than they save, such as wrappers with one caller, adapters with no second implementation, and speculative indirection that was never needed. Inline them.
- **Make adjacent layers change the abstraction.** A layer that repeats the same methods and arguments adds reader load without compression. Collapse pass-through layers.
- **Demand interface compression.** A broad interface that hides little complexity makes readers learn both the surface and the implementation. Prefer boundaries that hide meaningful decisions.
- **Shrink state scope.** Prefer pure functions (returns over mutations), locals over fields, fields over module state, and module state over globals. Derive instead of sync.
- **Name the invariant at the boundary,** not in every consumer, so the reader learns it once.
- Before adding a layer or a piece of state, ask whether it reduces reader load elsewhere by at least as much.

**The test.** Can a new reader answer "where does X come from?" and "what can change X?" in under 30 seconds? If not, cut layers or cut state.
