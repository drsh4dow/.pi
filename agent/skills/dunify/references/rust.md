# Rust

The dunify reference for Rust. Checked on stable Rust 1.99.1 with clippy and rustfmt 1.10.0, cargo-deny 0.20.2, cargo-machete 0.9.2 and ast-grep 0.51.3. Lint lists differ by toolchain, so run every command here on the toolchain the repo pins.

## Source root and edge file

The source root is the crate's `src/`. With two runtimes, make a Cargo workspace. Each runtime directory is a binary crate at the workspace root, and `shared` is a library crate both depend on. A binary crate cannot be a dependency, so an import between runtimes fails with `E0432`. In `shared/src/lib.rs`, declare each contract with `pub mod`, since clippy `pub_use` rejects `pub use`. Inside a crate, `features/`, `client/` and `primitives/` are modules, and each folder's `mod.rs` is its edge file. A feature's `mod.rs` declares its inner modules with plain `mod summary;` and re-exports with `pub(crate) use summary::summarize;`. Mark items in inner files `pub(crate)`. A plain `mod` is private to its parent, so another feature reaching `reports::summary::summarize` fails with `E0603`. clippy `definition_in_module_root` keeps every `mod.rs` down to `mod` lines and re-exports.

## Ceiling

List the rules from the installed tools with `rustc -W help` and `clippy-driver -W help`. Put the lints in the workspace root `Cargo.toml`, and give every member `[lints]` with `workspace = true`:

```toml
[workspace.lints.rust]
dead_code_pub_in_binary = "allow" # collides with each library's test target
unused_crate_dependencies = "allow" # collides with tests/ targets, cargo machete covers it

[workspace.lints.clippy]
all = { level = "warn", priority = -1 }
pedantic = { level = "warn", priority = -1 }
cargo = { level = "warn", priority = -1 }
restriction = { level = "warn", priority = -1 }
blanket_clippy_restriction_lints = "allow" # collides with the restriction group
implicit_return = "allow" # collides with needless_return
mod_module_files = "allow" # collides with self_named_module_files, mod.rs is the edge file
pattern_type_mismatch = "allow" # collides with ref_patterns
pub_with_shorthand = "allow" # collides with pub_without_shorthand
semicolon_outside_block = "allow" # collides with semicolon_inside_block
separated_literal_suffix = "allow" # collides with unseparated_literal_suffix
```

Set every level to `warn`. The check turns warnings into errors with `-D warnings`, while `cargo build`, `cargo test` and a release image still pass on a baselined violation. Keep groups at priority -1 so a single-lint line at the default 0 overrides them, since clippy `lint_groups_priority` rejects a tie. Leaving `nursery` out keeps it at allow. Append rustc's allow-by-default lints to `[workspace.lints.rust]` with this command, then delete each line `cargo clippy` reports as `unknown lint`, since the list includes unstable lints:

```sh
rustc -W help | awk '$2 == "allow" && $1 !~ /^(dead-code-pub-in-binary|unused-crate-dependencies)$/ { gsub("-", "_", $1); print $1 " = \"warn\"" }'
```

## Known collisions

The ledger lines above are the collisions found so far. Treat them as a starting list. To prove a line, set its lint to `warn`, write each spelling of the construct, and keep the line only when every spelling fails a side. `pattern_type_mismatch` and `ref_patterns`, for one, collide on a `match` over a borrowed enum that holds a `String`. `question_mark_used` and `question_mark` look like a pair, but clippy silences `question_mark` while `question_mark_used` is on, so `question_mark_used` goes to the user's list.

## Boundaries

Cargo enforces the runtime boundary, and visibility enforces each feature's inner modules. Write `boundaries.yml` for the rest. Run every ast-grep rule from the workspace root, since `files` and `ignores` match paths relative to the working directory, and scan the member folders by name, so the gate fixtures stay out of the scan.

```yaml
id: primitives-import-nothing-from-the-app
language: Rust
severity: error
message: primitives/ knows no feature, no client and no contract. Take the value as an argument.
files: ["**/src/primitives/**"]
rule: { any: [kind: use_declaration, kind: scoped_identifier], regex: '\b(features|client|shared)\b' }
---
id: client-imports-no-feature
language: Rust
severity: error
message: client/ never calls a feature. Return the value and let the feature call client/.
files: ["**/src/client/**"]
rule: { any: [kind: use_declaration, kind: scoped_identifier], regex: '\bfeatures\b' }
---
id: feature-inner-modules-stay-private
language: Rust
severity: error
message: Declare a feature's inner modules with plain `mod` and re-export them from mod.rs.
files: ["**/src/features/*/mod.rs"]
rule: { kind: mod_item, has: { kind: visibility_modifier } }
---
id: lint-levels-live-in-cargo-toml
language: Rust
severity: error
message: Set lint levels in [workspace.lints]. Only a ban's owner file carries an expect attribute.
ignores: ["server/src/client/scheduler.rs"]
rule: { kind: attribute, regex: '\b(allow|expect|warn|deny|forbid)\s*\(' }
```

## Bans

Put the bans in `clippy.toml` at the workspace root, which clippy applies to every member. Each `reason` prints under its violation:

```toml
disallowed-methods = [
	{ path = "std::thread::sleep", reason = "Call client::scheduler::wait." },
	{ path = "std::env::var", reason = "Call client::config::get." },
	{ path = "std::process::Command::new", reason = "Call a function in client/." },
	{ path = "std::time::SystemTime::now", reason = "Call client::clock::now." },
]
disallowed-types = [{ path = "std::fs::File", reason = "Call the client/ function that owns this file." }]
disallowed-macros = [{ path = "std::thread_local", reason = "Keep durable state in client/." }]
```

Clippy config has no path scope. Exempt the owner with `#![expect(clippy::disallowed_methods, reason = "client::scheduler owns std::thread::sleep")]` at the top of its file, and list that file under `ignores` in `lint-levels-live-in-cargo-toml`. The check fails with `unfulfilled_lint_expectations` once the owner stops calling the API. The attribute exempts the file from every entry of that lint, so give each owner its own file. A ban's fixture is its own crate under `gates/fixtures/`, with an empty `[workspace]` table and `disallowed_methods = "deny"` under `[lints.clippy]`. Clippy finds the root `clippy.toml` from there, and the gate test runs `cargo clippy --manifest-path` on it.

## Comment check

Set `language: Rust`. The kinds are `line_comment` and `block_comment`, and `kind: comment` fails to parse. A doc comment is one of those two kinds with a `doc_comment` child, so the rule lets `///`, `//!`, `/** */` and `/*! */` pass. rustc's `unused_doc_comments` rejects a doc comment on a statement or an expression. Rust tools take directives as attributes, so the only other exclusion is the license header at the top of the file:

```yaml
rule:
   any:
      - kind: line_comment
      - kind: block_comment
   not:
      any:
         - has: { kind: doc_comment }
         - all:
              - regex: '^(//|/\*)[\s\S]*(Copyright|SPDX-License-Identifier)'
              - inside: { kind: source_file }
              - not: { follows: { not: { any: [kind: line_comment, kind: block_comment] }, stopBy: end } }
```

## Baseline

Clippy, rustc and ast-grep have no baseline. Write the budget script as a binary in an `xtask` workspace crate, which sits under the ceiling like any member. Add it to every build file that lists the members, such as a Dockerfile. It reads `cargo clippy --workspace --all-targets --message-format=json`, where every lint arrives as a warning and the exit code is 0. Read the lines whose `reason` is `compiler-message`. Fail on any message at `error` level, which is a compile error or a rustc lint that denies by default, and fix it. Count each `warning` once per `message.code.code` and per `file_name`, line and column of the span with `is_primary`, since `--all-targets` reports a lint once per target. Count comments by `ruleId` and `file` from `ast-grep scan --rule no-comments.yml --json=stream` on the member folders. The budget script replaces the clippy step and the comment scan in the check.

## Check command

Cargo ignores an alias named `check`, because the built-in command wins. Where the repo has no runner, write a `justfile` whose `check` recipe runs `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `ast-grep scan --rule no-comments.yml` and `ast-grep scan --rule boundaries.yml` on the member folders, `cargo deny check`, `cargo machete` and `cargo test --workspace`. `cargo fmt --check` and `cargo machete` exit 1 on a diff or an unused dependency. `cargo deny check` rejects the workspace's own crates under licenses until `deny.toml` sets `ignore = true` under `[licenses.private]`. Put each advisory it reports in the user's list from step 4, and upgrade no dependency on your own.
