# Glossary

## Layout

See `docs/adr/0001-harness-layout.md`.

- **Host.** The program that loads an entrypoint: pi.
- **Entrypoint.** The file pi loads for one extension, `agent/extensions/<name>/index.ts`. It only wires a feature into pi.
- **Feature.** One piece of harness behavior, in `features/<name>/`, used only through its `index.ts`.
- **Client.** A typed adapter to one outside system, such as hc, systemd or pi's session store, in `clients/<system>/index.ts`.

## Tool context

- **Tool context.** The `<tools>` list (each tool's one-line snippet) and the `<rules>` list (each tool's and extension's guidelines) that pi writes into its default prompt. A custom `SYSTEM.md` replaces that prompt and drops both, so the `tool-context` feature (`features/tool-context/`) adds them back. The root and every delegate load it. It leaves out pi's generic rules (the bash file-ops rule, "Be concise", "Show file paths clearly") and the "Additional tools may be available" line, since `SYSTEM.md` sets its own style.

## Owned work

Terms from the owned-work feature (`features/owned-work/`).

- **Owned work.** Every delegate, serve, watch and group a pi process started. It dies with that process.
- **Delegate.** A child pi started on one task message. It answers once, as its last assistant text, and cannot ask its parent anything. Configs live in `agent/delegates/<name>.ts`, and a trusted project's `.pi/delegates/` overrides them by name.
- **Role.** Where an agent sits: the **root** is the pi the user runs, an **owner** is a delegate that may start delegates of its own, and a **leaf** may not. A serve or watch runs as a leaf, so a pi it starts cannot delegate.
- **Serve.** A long-running command, such as a dev server. It runs until stopped, or until the group holding it settles. Its end never wakes anyone: it is delivered in its group's result, beside a job's result, or in a `stop` reply. A serve that fails to spawn fails its own `serve` call instead.
- **Watch.** A command whose exit wakes the agent with its exit code and last lines.
- **Job.** A delegate, a watch or a group: work that settles with a result. A serve is not a job.
- **Group.** Work moved out of the agent's hands into one unit. Mode **all** wakes the agent once with every result. Mode **each** wakes it once per result.
- **Holder.** Who receives a piece of work's result: the agent, or the group it was moved into.
- **Handle.** The plain JSON a start tool returns, such as `{ "ref": "delegate-3", "kind": "delegate", "terminal": "t7" }`.
- **Ref.** A handle's id, such as `delegate-3`. Unique within one pi process.
- **Settle.** A job's end: done, fired, failed, or a group's member results. The ledger also writes a settle entry when a serve ends, so every piece of work has one.
- **Deliver.** Hand a settled result to the agent, exactly once: at the end of a turn, by a wake while idle, or in a `stop` reply.
- **Wake.** A message that carries results to an idle agent and starts its next turn.
- **Ledger.** The one module that records owned work, who holds it and what was delivered. It writes the `owned-work` session entries.
- **Anchor.** One hc terminal per pi process, running `tail --pid=<pi pid>`. Every terminal the agent starts sits under it, so killing pi ends each terminal's program. Its slice ends the rest.
- **Slice.** The systemd user slice a delegate, serve or watch runs in, named `<owner's slice>-<ref without dashes>`, such as `pi-ow-1a2b3c4d-delegate3`. The root's slice is `pi-ow-<agent key>`, and the work's own work nests below its slice. Settling the work stops its slice, which ends every process in it, even one that left its process group. A user service of the same name watches the root's pid and stops the root's slice when the root dies.
- **Child session.** A delegate's own pi session, in the `delegates/` folder next to the root's sessions, so `pi -c` never opens one.
- **Staged files.** A delegate's task message and system prompt, written as `<session id>.message` and `<session id>.prompt` beside its child session, because one argv word holds at most 128 KiB. The ledger deletes them when the delegate settles.
