# Coding standards

## Rules a gate enforces

`bun run check` runs every gate below. A rule here needs no reminder, only the gate's message when it fails.

| Rule                                                                                                    | Gate                                                                                         |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Code is formatted                                                                                       | `oxfmt --check`                                                                              |
| Every stable oxlint rule holds, each rule that is off has its reason beside it                          | `bun run lint`, `.oxlintrc.jsonc`, `oxlint-effect.json`                                      |
| Types are strict, TypeScript syntax is erasable                                                         | `tsc`, `tsconfig.json`                                                                       |
| A feature imports its own files, another feature's or a client's `index.ts`, and `src/primitives/`      | `bun run boundaries`, `.dependency-cruiser.json`                                             |
| A client imports its own files, another client's `index.ts`, and `src/primitives/`                      | `bun run boundaries`                                                                         |
| `src/primitives/` imports nothing else from the repo                                                    | `bun run boundaries`                                                                         |
| An entry file imports only a feature's or a client's `index.ts`                                         | `bun run boundaries`                                                                         |
| Production code never imports test code or the PHI eval corpus, and nothing imports a scenario          | `bun run boundaries`                                                                         |
| Only `piHost` in `src/client/pi-host/` runs an Effect                                                   | oxlint `no-restricted-properties`                                                            |
| Only `src/client/` touches disk, HTTP or a child process                                                | oxlint `no-restricted-imports`, `no-restricted-properties`                                   |
| Test code waits on a condition with `eventually`, never a fixed sleep                                   | oxlint `no-restricted-properties`                                                            |
| Only entry files read the environment                                                                   | oxlint `node/no-process-env`, and `no-restricted-properties` on `Bun.env`                    |
| owned-work resolves a delegate's model with `modelOf`                                                   | `tools/ast-grep/rules/delegate-model-lookup.yml`                                             |
| A source file holds no comment but a doc comment on a declaration, a tool directive or a license header | `tools/ast-grep/rules/no-comments.yml`                                                       |
| No suppression directive such as `oxlint-disable` or `@ts-expect-error`                                 | `tools/ast-grep/rules/no-suppression.yml`                                                    |
| Imports sit at the top of the file                                                                      | `tools/ast-grep/rules/no-dynamic-import.yml`                                                 |
| Relative imports end in `.ts`                                                                           | `tools/ast-grep/rules/relative-import-extension.yml`                                         |
| No unused file, export or dependency                                                                    | `bun run knip`, `knip.jsonc`                                                                 |
| Violations that predate a rule only fall                                                                | oxlint with `oxlint-suppressions.json`, `bun run sg` with `tools/gates/ast-grep-budget.json` |
| Each gate fails on a fixture that breaks it                                                             | `tools/gates/gates.test.ts`                                                                  |
| Credentials and session history stay out of git                                                         | the allowlist `.gitignore`                                                                   |

When you clear baselined violations, commit the lower counts: `oxlint src tools agent/extensions agent/bin --prune-suppressions` and `bun tools/gates/budget.ts --write`.

## Rules that need judgment

- **A gate that fails caught something.** Fix the code. When a rule is wrong for this repo, such as an Effect or pi idiom it rejects, take it to the user with what it flags and your pick. A rule goes off only with their approval, or when files prove that no spelling satisfies it and another rule together. Its off line in `.oxlintrc.jsonc` names the reason, and the idiom joins `tools/oxlint/fixtures/effect-pi-idioms.ts`.
- **Each durable value has one writer.** A new file, store or label gets its folder in `src/client/` before a feature writes it, and every writer calls that client.
- **New product work adds a folder.** A new piece of behavior goes in `src/features/<name>/`, with its entry file in `agent/extensions/<name>/index.ts` or `agent/bin/<name>.ts`.
- **Tests run in parallel workers.** A test shares no fixed path, port or process with another file.
- **A fact about the harness at runtime needs a scenario.** Prove it with a `*.scenario.ts` run by the driver, as `tools/driver/README.md` describes, not with a unit test or a reading of the code.
- **The harness itself follows pi's docs.** Before you change an extension, `SYSTEM.md`, a role file or a principle, read `node_modules/@earendil-works/pi-coding-agent/README.md` and its `docs/` and `examples/`.
- **Prompt changes get a look at the result.** After changing `SYSTEM.md`, a role file, a principle, an extension's prompt guidelines or a file in `agent/instructions/`, run `bun run prompts [project-dir]`. It writes `system-prompts.md` (gitignored) with the full prompt each kind of agent gets. Every agent but stock pi runs on this checkout's `agent/`, so a git worktree shows its own prompts.
- **An extension with its own `package.json`** lists the packages pi supplies at runtime (`@earendil-works/pi-*`, `typebox`) in `peerDependencies` with `"*"`.
- **Vendored code keeps its upstream.** `tools/oxlint/anti-slop/` changes only through the `install-anti-slop` skill, recorded in its `UPSTREAM.md`. The code inside skills and playbooks (`scripts/`, `templates/`, `cli/`) is outside oxfmt, oxlint and tsc, and `bun test` still runs its tests.
- **Herdr-App and Herdr-Core** follow `~/.config/herdr-app/AGENTS.md`. Read it before you change them.
