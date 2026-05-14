---
name: good-coding-practices
description: Applies modern, language-agnostic constraints for bounded, analyzable, production code. Use before writing or designing code, always.
---

# Good Coding Practices

Use these rules as hard implementation constraints. The goal: code that is bounded, analyzable, explicit, and tool-checkable.

If a implementation requires violating a rule, stop and redesign. Do not suggest exceptions, waivers, or "documented violations." When editing existing code, treat related violations as blockers before changing that logic. Do not let violations spread.

## The Ten Rules

### 1. Use simple, explicit control flow

Do not use hidden, nonlinear, or hard-to-analyze control flow: recursion, `goto`-style jumps, reflection-driven dispatch, callback mazes, dynamic imports for behavior selection, magic decorators/metaclasses for core behavior, or panic/exception-driven normal flow. Prefer direct calls, explicit state machines, and boring branches.

### 2. Bound every loop

Every loop must have an obvious finite bound. Iteration over a collection is allowed only when the collection size is bounded by construction or validation. Retries need max attempts. Polling needs timeout/deadline. Service loops need explicit shutdown/cancellation. No uncontrolled `while true`.

### 3. Bound all resource use

Resource growth must be capped and visible: memory, queues, caches, buffers, files, sockets, database cursors/connections, subprocesses, goroutines, tasks, threads, fanout, and retries. No unbounded allocation, buffering, caching, spawning, or work amplification.

### 4. Keep functions substantial but mentally small

A function should be worth naming and fit on one mental page. Target 5-60 executable lines, not counting comments or blank lines. Do not create trivial wrappers, pass-through getters, one-line aliases, or tiny functions extracted only to satisfy Clean Code/DRY habits. Inline them or keep the logic local. Split only when the new function improves reasoning, names a real concept, isolates a boundary, or removes substantial duplication.

### 5. Assert invariants; handle expected failures explicitly

Use assertions only for impossible states and invariants. Assertions must be side-effect free, meaningful, and local to the invariant. Do not use assertions for expected input or runtime failures. Expected failures must use explicit error handling: typed errors/results or boundary throws in TypeScript, `Result`/`Option` in Rust, checked `error` in Go, and explicit exceptions in Python.

### 6. Minimize scope, mutability, and lifetime

Declare data at the smallest useful scope. Prefer immutable bindings, private/module-local visibility, short lifetimes, and single-purpose variables. Avoid global mutable state and reusable scratch variables for unrelated purposes.

### 7. Check every fallible operation

Every fallible operation must be handled immediately, propagated, or converted into a typed failure. Do not ignore Go `err`, discard Rust `Result`, float TypeScript promises, swallow Python exceptions, ignore nullable/optional values, or ignore API return values that signal failure.

### 8. Avoid hidden code and hidden variants

Do not hide behavior behind metaprogramming or configuration forks: obscure macros, runtime code generation, monkeypatching, reflection-heavy critical paths, import-time side effects, conditional compilation, build tags, or feature flags that create untested variants. Behavior must be visible in source.

### 9. Make ownership and shared state obvious

Avoid complex aliasing and hidden mutation. Do not use shared mutable globals, data races, undocumented input mutation, deeply nested reference graphs, Rust `unsafe`, Rust `Rc<RefCell<_>>`-style escape hatches in critical logic, or Go shared maps/slices across goroutines without synchronization. Ownership must be locally understandable.

### 10. Use strict tools from day one

Code must pass strict formatting, compiler, linter, type, and static-analysis checks with zero warnings. Rewrite confusing code until tools are quiet. Baselines: TypeScript `strict` plus Biome recommended defaults; Rust `cargo fmt` plus `clippy -D warnings` and no `unsafe`; Go `gofmt`, `go vet`, `staticcheck`; Python `ruff`, `pyright`, and tests.

## Workflow

1. Before coding, identify which rules constrain the design.
2. Design bounded control flow, bounded resources, explicit errors, visible ownership, and useful function boundaries.
3. Refuse requests that require a rule violation; offer a compliant alternative.
4. While editing, remove related violations instead of building on them.
5. Verify with the project's strictest available formatter, compiler/typechecker, linter, static analyzer, and tests.
