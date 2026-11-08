# Glossary

## Layout

See `docs/adr/0001-harness-layout.md`.

- **Host.** The program that loads an entrypoint: pi.
- **Entrypoint.** The file pi loads for one extension, `agent/extensions/<name>/index.ts`. It only wires a feature into pi.
- **Feature.** One piece of harness behavior, in `features/<name>/`, used only through its `index.ts`.
- **Client.** A typed adapter to one outside system, such as hc, systemd or pi's session store, in `clients/<system>/index.ts`.

## Tool context

- **Tool context.** The `<tools>` list (each tool's one-line snippet) and the `<rules>` list (each tool's and extension's guidelines) that pi writes into its default prompt. A custom `SYSTEM.md` replaces that prompt and drops both, so the `tool-context` feature (`features/tool-context/`) adds them back. The root and every delegate load it. It leaves out pi's generic rules (the bash file-ops rule, "Be concise", "Show file paths clearly") and the "Additional tools may be available" line, since `SYSTEM.md` sets its own style.
