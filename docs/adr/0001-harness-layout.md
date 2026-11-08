# Harness code is split into entrypoints, features and clients, and a lint rule holds the import graph

The harness follows the principles of Lauren Tan's Dune framework. Those are features, entrypoints, clients and hosts, typed interfaces between them, boundaries held by the import graph in CI, and lint rules over prose rules. Dune's own folder names are not public, so these names are ours. Every harness extension uses this layout:

- `agent/extensions/<name>/index.ts` is the **entrypoint** that pi, the host, loads. It only wires a feature into pi's events.
- `features/<name>/` holds the **feature**. Its `index.ts` is the feature's whole public interface, and every other file in the folder is internal.
- `clients/<system>/index.ts` is a **client**: a typed adapter to one outside system, such as hc, systemd or pi's session store, written as an Effect Service plus Layer. The system's wire formats stay inside it.

The `harness/import-boundaries` rule in `tools/oxlint/harness/` fails `bun run check` on any import that breaks the graph:

- An entrypoint imports only a feature's `index.ts`.
- A feature imports other features and clients only through their `index.ts`.
- A client never imports a feature or an entrypoint. It may import another client's `index.ts`.
- Nothing outside an entrypoint imports it.

We picked a lint rule over a prose rule because the graph is cheap to check on every run, and prose drifts.

## Consequences

- A type that a feature and a client share lives in the client. A client that would need a feature's type takes a plain one, so the systemd client takes a work's ref as a `string`, and hc stamps its notices with a raw monotonic `bigint` that the feature brands.
- Harness delegates live in `agent/delegates/`, which is `~/.pi/agent/delegates/` once installed. A project's delegates live in `.pi/delegates/`. This follows pi's own pairing of `~/.pi/agent/extensions/` with `.pi/extensions/`.
- The rule finds a file's layer from the last `agent/extensions/`, `features/` or `clients/` in its path, so no folder inside a layer may take one of those names.
