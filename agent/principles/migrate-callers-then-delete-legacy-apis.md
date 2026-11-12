---
when: Introducing a new internal API, type, or module while callers of the old one still exist.
---

# Migrate Callers Then Delete Legacy APIs

Migrate callers and delete the old API in the same wave instead of preserving compatibility layers.

- Update tests to assert the new contract, and delete tests that only protect pre-refactor implementation details

**When this applies:**

- No external users depend on backward compatibility
- The project can absorb coordinated breaking changes
- The new API is part of a simplification or refactor initiative
