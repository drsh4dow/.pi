---
when: Introducing a new internal API, type, or module while callers of the old one still exist.
---

# Migrate Callers Then Delete Legacy APIs

When a new internal API replaces an old one, migrate every caller and delete the old API in the same wave. Do not keep a compatibility layer.

- Update tests to assert the new contract, and delete tests that only protect pre-refactor implementation details.

**When this applies:**

- No external users depend on backward compatibility.
- The project can absorb coordinated breaking changes.
- The new API is part of a simplification or refactor.
