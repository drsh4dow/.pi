# Glossary

## Layout

See `docs/adr/0001-harness-layout.md`.

- **Host.** The program that loads an entrypoint: pi.
- **Entrypoint.** The file pi loads for one extension, `agent/extensions/<name>/index.ts`. It only wires a feature into pi.
- **Feature.** One piece of harness behavior, in `features/<name>/`, used only through its `index.ts`.
- **Client.** A typed adapter to one outside system, such as hc, systemd or pi's session store, in `clients/<system>/index.ts`.
