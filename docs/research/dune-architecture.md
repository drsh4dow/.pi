# Dune architecture: research for the dune skill

Research date 2026-11-16. This file is the cited input to the design of a user-invoked skill that sets up or migrates a codebase toward a Dune-style architecture. Raw evidence, generated configs and full per-language references are in `~/.local/state/pi-agent/pi/dune-skill/research/`, named below as `R/`.

## What Dune is

Dune is the internal client framework of the Grok Bot team at SpaceXSI. It is not public. Lauren Tan (poteto) describes it in two talks.

- "Kind of like Next.js for Electron apps", and "not really that interesting technically". Its value is "a lot of constraints and lint rules" that encode lessons from building desktop apps. Source: [All Code Is Slop (Except Mine)](https://www.youtube.com/watch?v=O_zcc6Xl12g) at 5:00, transcript `R/talk-transcript.md`.
- The slide at 5:00 reads "dune: a framework for agents. app framework (navigation, rendering, IPC) + one folder per feature, strict import bans, no comments in code". Source: `R/talk-slides.md`, frame `slide-05-00.png`.
- An earlier talk adds the nouns. Features are "collocated in a single folder". An entry point is "kind of like a route". There are transcript cards, a host that runs on the Grok Bot virtual machine, and a client. Boundaries are enforced "through the import and dependency graph". Source: [earlier talk](https://www.youtube.com/watch?v=Z-jNqqIYGm4).

## Dune's own design docs, as shown on screen

The September talk scrolls through a board titled "Based on dune/docs", and the August interview shows the same document. This is the closest public view of Dune's design. Sources: [September talk](https://www.youtube.com/watch?v=Z-jNqqIYGm4) at 27:20 to 29:25, findings in `R/talk-2026-09-dune.md`. [August interview](https://www.youtube.com/watch?v=Tb5GnV3Nxa4) at 13:10 and 17:20, findings in `R/interview-2026-08-dune.md`. Four frames were checked by eye: `0329.jpg`, `0352.jpg`, `0353.jpg` and `rapid/012.jpg` under `/tmp/dune/talk-2026-09/`.

**The model of a contributor.** "A coding agent usually optimizes for what fits in its context: copy the nearest working pattern; edit the file already open; choose the shortest path that compiles; avoid deleting code whose callers are not visible; follow the requested implementation even when it conflicts with a system invariant."

**The five rules.**

1. "The conventional path requires fewer decisions than a shortcut."
2. "Forbidden dependencies fail mechanically."
3. "Every durable value has one obvious writer."
4. "New product work adds isolated files rather than branches in shared roots."
5. "Exceptions are narrow, explicit, and reviewed as architecture changes."

**The five nouns.** "Each noun has one place in the tree and one job at runtime."

| Noun            | Job                                                                                        | Place                                                                                |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Feature         | "One owned folder for product UI"                                                          | `features/<name>/`, with `index.ts` as the "public cross-feature edge"               |
| Entrypoint      | "One view a user can open"                                                                 | `features/<name>/workspace/entrypoint.ts` and `view.tsx`, found by reserved filename |
| Transcript card | "Feature-owned body for one entry type"                                                    | inside the feature, found by reserved filename                                       |
| Client          | "Durable renderer state behind hooks and commands", "one writer", "owns the local replica" | `client/<name>-store.ts`, a source adapter, a named hook and command                 |
| Host            | "Always-on behavior behind a typed contract"                                               | `extensions/<name>/` with `extension.ts`, `api.d.ts`, a service and a test           |

**The shared edge.** `shared/<name>-rpc.ts`, built with `declareRpcEdge`, carries "typed args + failures", and "both processes import it". "The component never handles IPC channels, Host peer lookup, retry ordering, or process startup."

**Folders and processes.** "A folder tells an agent where code runs and which imports are legal." The renderer holds Feature UI, Navigation ("links only") and Client ("replica + commands"). The serving processes are Host extensions ("durable domain behavior") and Electron main ("windows + OS capabilities"). "shared/ holds cross-process types. Each process imports only its allowed layers."

**Discovery over registries.** "A feature adds files, not registry branches. Reserved filenames turn the nearby folder into the complete contribution." A crossed-out `shared registry.ts` is labeled "no second list". "Two agents can add different feature folders without editing the same root."

**Where each mistake is caught.** "The same mistake becomes cheaper when the system rejects it earlier."

| Stage          | Catches                                                    |
| -------------- | ---------------------------------------------------------- |
| Edit time      | "exports, target projects, branded links, typed contracts" |
| Build          | "reserved-file discovery, Host peer graph, React Compiler" |
| Renderer start | "duplicate ids, missing views, invalid card paths"         |
| Lint           | "wrong imports, raw RPC, timers, effects, file growth"     |
| Test           | "public contract suites and tests that can fail"           |

The diagnostic "names the expected owner or API". The order of investment is "Types first. Build checks next. Scaffolds next. Prose last."

**The framework is its own package.** "Dune lives at sand/dune, the application lives under sand/src, and Dune never imports application code."

**The definition of agent-friendly.** "Agent-friendly means a correct open-file edit preserves the whole app's invariants."

## Layout prior art

Full comparison: `R/runtime-layout-comparisons.md`. No surveyed codebase repeats one set of inner folders in every runtime. VS Code names folders by layer and by target environment (`common`, `browser`, `node`, `electron-browser`, `electron-main`), per its [Source Code Organization](https://github.com/microsoft/vscode/wiki/Source-Code-Organization) wiki. Feature-Sliced Design fixes the layer names and leaves slice names to the business. Hyper and Signal use different trees in the main process and the renderer. This harness uses entrypoints, features and clients under ADR 0001, where a client is "a typed adapter to one outside system" and a feature reaches another only through its `index.ts`. It has 13 features and 10 clients, and 15 cross-feature imports in production files (`R/adr-0001-provenance.md`).

## The five tiers of trust

The slide at 2:00, "the poteto pyramid", ranks where to invest, cheapest and most reproducible first.

1. Codebase: good API design, architecture, refactoring.
2. Static analysis: lints, types, compilers, tests, CI.
3. Verification: formal and runtime.
4. Prose: rules, skills, AGENTS.md.
5. Human review.

The spoken rule is "whenever you're correcting your agent, think about how you can make that a deterministic check instead of adding another line to your rules" (3:00). The 9:10 slide reads "lint against it or categorically eliminate the problem".

## What is confirmed about Dune's rules

| Rule                                                                                                                                                                                      | Evidence                                                   | Limits                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level directories are named for where code runs: `electron-renderer/` and `electron-main/`.                                                                                           | Slide at 6:10, "directory structure is a form of context". |                                                                                                                                                   |
| `electron-renderer/` holds `features/`, `client/`, `primitives/`. `electron-main/` holds `startup/`, `notifications/`, `update/`.                                                         | Same slide.                                                | `client/` is the Client noun defined above. `primitives/` is defined nowhere public, and the full import rules among the three are not stated.    |
| Renderer and main may not import each other, "not even types". Both import `shared/`, labeled "shared types".                                                                             | Slide at 6:25, checked against the frame image.            | What else `shared/` may hold is not stated.                                                                                                       |
| The ban is enforced by "our dependency graph analyzer and some lint rules".                                                                                                               | Talk at 6:30.                                              | Neither tool is named anywhere public.                                                                                                            |
| File names carry constraints too. `src/sim/tick.hot.ts` means "runs every tick" and "no allocations".                                                                                     | Same slide, from the speaker's side project.               | Not a Dune example.                                                                                                                               |
| `useEffect` is banned in product code and "only allowed in some places inside of Dune APIs". The principle is "anything that requires nuance to use well often leads to slop".            | Talk at 5:30.                                              | No full list of banned APIs is public. The September board lists what Dune's lints catch: "wrong imports, raw RPC, timers, effects, file growth". |
| "Ban 99% of comments". Comments go stale, give an agent "an escape hatch to justify not doing the right thing", and "they're not enforceable". Count went from 65,824 on Jul 31 to 1,227. | Talk at 8:20 and its slide.                                | The allowed 1% is not defined for Dune.                                                                                                           |
| Lint rules "give good and very helpful error messages telling the agent to fix the root cause".                                                                                           | Talk at 9:00.                                              | No Dune lint message is shown on any slide.                                                                                                       |
| Adoption order is lint first, cleanup second. "Start with a lint rule to prevent new occurrences of anti-patterns, and then clean up those old patterns as well."                         | Talk at 15:10.                                             |                                                                                                                                                   |

## What Dune does not say

"Enable every lint rule in every category" is not in either talk. Dune's lints are bespoke rules written from corrections. The 9:10 slide counts them: 7 on Jul 1, 167 on Nov 1. Maximum off-the-shelf strictness is this skill's own extension of the static-analysis tier.

## The public method behind it: pstack

pstack is the speaker's public plugin. It is her working method, not Dune's source. This harness already carries its skills under the same names.

- `correct` turns a correction into the highest tier that works: architecture, then types, then a lint or CI check "whose error names the file, type, or function to use instead", then tests, then docs. For a pattern already common, "fail only when a change adds more". It keeps a table that pairs each rule with what enforces it. Local: `agent/skills/correct/SKILL.md`.
- `no-comments` and `agent/instructions/comment-sicko.md` define the allowed comments: license headers, unavoidable external constraints, formatter and style-only lint directives, public API contracts, and issue links for constraints code cannot express.
- `create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill` and `statechart` cover the verification tier, including the feature map.
- `playbooks/constraint-driven-development.md` covers a written quality bar with ratchets.

## Maximum strictness, per ecosystem

Full references: `R/typescript-strictness.md`, `R/rust-python-go-strictness.md`. Versions are those current on the research date.

**No tool has a coherent "everything on" switch.** oxlint and clippy use the same sentence: "The restriction category should, emphatically, not be enabled as a whole. The contained lints may lint against perfectly reasonable code, may not have an alternative suggestion, and may contradict any other lints." Sources: [oxc rule.rs](https://github.com/oxc-project/oxc/blob/main/crates/oxc_linter/src/rule.rs), [clippy README](https://raw.githubusercontent.com/rust-lang/rust-clippy/rust-1.100.0/README.md). A local precedent that does it anyway is `~/Projects/hive/.oxlintrc.json`, with `restriction` at error and ten rules off.

- **TypeScript (oxlint 1.94.0, TypeScript 7.0.2).** Seven categories. `-D all` excludes nursery and enables no plugin, so plugins are listed by hand. Type-aware linting needs `oxlint-tsgolint` with `options.typeAware` and `options.typeCheck`. Known opposed pairs include `no-ternary` against `unicorn/prefer-ternary`, `import/no-default-export` against `import/prefer-default-export`, `import/no-named-export` with `no-default-export`, `oxc/no-async-await` against `typescript/promise-function-async`, and two vitest pairs reproduced on the real CLI (`R/oxlint-collision-result.json`). `dot-notation` no longer collides with `noPropertyAccessFromIndexSignature`. `isolatedDeclarations` collides with `allowJs`.
- **Effect (`@effect/tsgo` 0.69.1).** Its `strict` preset covers only diagnostics that are on by default, so "all rules" means setting each one. Generated fragments are in `R/effect-all-tsconfig-fragment.json` and `R/effect-all-oxlint-fragment.json`. It supports oxlint up to 1.93.0, so versions are pinned to its matrix, not to latest. `preferNamespaceImport` opposes `preferBarrelImport` on overlapping package lists.
- **Rust (1.100.0).** `clippy::all`, `pedantic`, `nursery`, `cargo` through `[workspace.lints]` with group priority `-1`. Opposed pairs in `restriction` include `implicit_return` against `needless_return`, `mod_module_files` against `self_named_module_files`, `pub_with_shorthand` against `pub_without_shorthand`, and the two literal-suffix lints. Plus `unsafe_code = "forbid"`, `rustfmt --check`, cargo-deny, cargo-machete.
- **Python (ruff 0.17.5).** `select = ["ALL"]`. Ruff drops D203 and D213 by itself. Its formatter doc lists W191, E111, E114, E117, D206, D300, Q000 to Q004, COM812 and COM819 as conflicts. ISC001 is no longer on that list. basedpyright `typeCheckingMode = "all"` is stricter than pyright `strict`.
- **Go (golangci-lint 2.15.0).** `linters.default: all`, with inner switches such as govet and gocritic `enable-all`. No official collision list exists.
- **Doc-comment rules collide with a comment ban.** clippy `missing_docs`, ruff D100 to D107, revive `exported`, godoclint and staticcheck ST1000 demand comments.

## Enforcement tools, per ecosystem

Full answer: `R/boundary-and-comment-tooling.md`.

| Need                                | TypeScript                                                                                                                                      | Rust                                                   | Python                                | Go                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------- | ----------------------------------- |
| Import boundaries on resolved edges | dependency-cruiser, eslint-plugin-boundaries through oxlint `jsPlugins` (alpha), a custom oxlint plugin as in `tools/oxlint/harness/`           | crate splits and visibility, cargo-modules `--acyclic` | import-linter, tach                   | `internal/`, depguard, go-arch-lint |
| Banned API with a message           | native `no-restricted-imports`, `no-restricted-globals`, `no-restricted-properties`. `no-restricted-syntax` only through `oxlint-plugin-eslint` | clippy `disallowed-methods` with `reason`              | ruff TID251 `banned-api` with `msg`   | forbidigo with `msg`                |
| Comment ban                         | no stock rule. `no-inline-comments` covers same-line comments only                                                                              | no clippy rule                                         | ERA001 covers commented-out code only | none                                |
| Shared contract                     | a schema module in `shared/` (Effect Schema, zod), typed IPC                                                                                    | a serde contract crate                                 | a pydantic package                    | a types package                     |

ast-grep 0.51.3 was run against fixtures in JavaScript, Python, Go and Rust. A `kind: comment` rule rejected ordinary comments and accepted license headers and comment-like strings. It is the one cross-language way found to make a comment ban a failing check.

## Local precedent

The pi harness already follows Dune's principles under its own names. `docs/adr/0001-harness-layout.md` splits code into entrypoints, features and clients. A feature's `index.ts` is its whole public interface. A client is a typed adapter to one outside system, and the system's wire formats stay inside it. The `harness/import-boundaries` rule in `tools/oxlint/harness/` fails `bun run check` on any import that breaks the graph, and its message names the file to import instead.

## Baselines for migration

Full answer: `R/ratchet-mechanisms.md`.

- oxlint has hidden `--suppress-all` and `--prune-suppressions` flags that write `oxlint-suppressions.json` with a count per file and rule. Run on oxlint 1.92.0: clean exit after suppressing, exit 1 after one new violation.
- basedpyright writes `.basedpyright/baseline.json` with `--writebaseline`. golangci-lint has `issues.new-from-merge-base`.
- ruff, clippy and `tsc` have no baseline. Ruff's `--add-noqa` writes a comment per line.

## Corrections from runs

The writers of the skill's reference files ran every config fragment with the real tools. Where a run disagreed with the research above, the run wins, and `agent/skills/dunify/references/` carries the corrected fact.

- **TypeScript.** `no-ternary` and `unicorn/prefer-ternary` are not a collision, since an early return passes both. oxfmt 0.79.0 keeps the parentheses that `unicorn/no-nested-ternary` wants. dependency-cruiser 18.7.2 under TypeScript 7 cruises 0 modules and exits 0 unless its parser is `swc`. oxlint's `--suppress-all` skips compiler diagnostics, and a count that falls passes silently.
- **Effect.** `@effect/tsgo` 0.69.1 is not on npm. The latest is 0.69.0, with 149 rules. The `preferNamespaceImport` and `preferBarrelImport` collision did not reproduce.
- **Rust.** `question_mark_used` and `question_mark` are not a collision. Doc comments are `line_comment` and `block_comment` nodes, with a `doc_comment` child, so one ast-grep rule tells them from plain comments, and `kind: comment` does not parse for Rust. The newest stable toolchain installed for the runs was 1.99.1.
- **Python.** At ruff 0.17.5's default formatter settings only COM812 conflicts with the formatter. CPY001 is stable, so `ALL` turns it on. A docstring is a string statement and no comment node, so the comment check does not see it.
- **Collisions the research missed.** In oxlint: `vitest/no-importing-vitest-globals` with `prefer-importing-vitest-globals`, `vitest/require-test-timeout` with `no-magic-numbers`, and anti-slop's `require-safety-comment-for-type-assertion` with the comment check. In clippy: `dead_code_pub_in_binary`, `unused_crate_dependencies`, `blanket_clippy_restriction_lints` and `pub_with_shorthand`.

## Gaps

- Dune's analyzer, its lint tool, its full banned-API list and the meaning of `primitives/` are not public.
- The full import rules inside the renderer are not public. Confirmed edges are feature to feature through `index.ts`, and feature to Client through hooks.
- Nothing public explains the folders of `electron-main/` beyond "windows + OS capabilities".
- A third-party gist by Michael Flores claims single-writer Client state and a typed Host contract. The September board now confirms both. Its other claims stay unverified.
- The collision lists are known examples, not complete graphs.
