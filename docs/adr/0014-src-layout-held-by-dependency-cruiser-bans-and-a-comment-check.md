---
status: accepted
supersedes: 0001
---

# Harness code lives in src/ by Dune's names, and dependency-cruiser, lint bans and an ast-grep check hold it

0001 split the code into entrypoints, `features/` and `clients/`, and held the import graph with a lint plugin of our own. The dunify skill asks for more: folder names that carry rules, one writer per durable value, and bans on APIs that take judgment. So the code moved under `src/`:

- `src/features/<name>/` holds one piece of product work. Its `index.ts` is the only file another feature imports.
- `src/client/<system>/` is the one writer of each durable value and the only code that touches disk, HTTP or a child process. `src/client/pi-host/` is the one place that runs an Effect.
- `src/primitives/` holds building blocks that know no feature and own no state, such as `eventually`, the one way test code waits.
- Imports across folders use the `#src/*` and `#tools/*` subpaths in `package.json`.

Two places stay where pi loads them, outside `src/`, as entry files: `agent/extensions/<name>/index.ts` and `agent/bin/<name>.ts`. An entry file imports only a feature's or a client's `index.ts`. Herdr-App and Herdr-Core stay outside the map, under their own rules.

`.dependency-cruiser.json` holds the boundaries, `.oxlintrc.jsonc` the bans with messages that name each owner, and `tools/ast-grep/rules/` the comment check, the relative `.ts` extension rule and the delegate model ban. `tools/gates/gates.test.ts` proves each gate fails on a fixture. A dependency-cruiser config replaced the plugin because it reads the resolved graph, type-only imports included, and its rules are data a reviewer reads without running code.

## Consequences

- A new durable value gets a folder in `src/client/` before any feature writes it.
- dependency-cruiser cannot use TypeScript 7.0, so it parses with swc and prints a `missing-tsc-transpiler` warning. `gates.test.ts` proves swc still sees type-only imports.
- The PHI eval corpus under `src/features/phi-router/corpus/` is test code. Production code never imports it.
