---
when: Sequencing or sizing an addition, refactor, or rewrite, about to build on code that carries dead code, redundant checks, or stub references, or tempted to add an abstraction or a signal threaded through several functions.
---

# Subtract Before You Add

When evolving a system, remove complexity first, then build. Default to subtraction and the smallest change that solves the problem.

Make simplification a continual investment. Leave the design slightly simpler and more capable behind the same or smaller surface than you found it.

- Sequence removal before construction.
- Cut before you polish. Get to the minimum before investing in quality.
- Minimize the diff. Fewer lines beat "elegant" boilerplate.
- Consolidate decisions. Do not repeat the same choice in several places. Put it behind one source of truth and pass the result as a simple flag.
- Design for observed usage, not speculative edge cases.
- Add no speculative validators, parsers, or guards beyond what the spec demands.
- Simplify prompts by removing redundant instructions and excessive templates.
- When a reference has no novel content, delete it rather than leaving a stub.
