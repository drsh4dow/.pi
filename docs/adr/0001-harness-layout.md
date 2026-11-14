# Harness code is split into entrypoints, features and clients, and a lint rule holds the import graph

The harness follows the principles of Lauren Tan's Dune framework. Those are features, entrypoints, clients and hosts, typed interfaces between them, boundaries held by the import graph in CI, and lint rules over prose rules. Dune's own folder names are not public, so these names are ours. Every harness extension uses this layout:

- `agent/extensions/<name>/index.ts` is the **entrypoint** that pi, the host, loads. It only wires a feature into pi's events.
- `agent/bin/<name>.ts` is an **entrypoint** too: a command that wires one feature to argv and stdio. owned-work puts `agent/bin/` first on PATH for each command and delegate it starts, and pi's bash adds it first when PATH lacks it. A small `sh` file `agent/bin/<name>` runs the script with bun.
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
- Harness instructions files live in `agent/instructions/`, which is `~/.pi/agent/instructions/` once installed. A skill names one by that path in a `delegate` call, and a project passes the path of its own.
- The rule finds a file's layer from the last `agent/extensions/`, `features/` or `clients/` in its path, so no folder inside a layer may take one of those names. A file directly in `agent/bin/` is an entrypoint wherever the folder sits.
