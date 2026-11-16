# Python

The dunify reference for Python, used in steps 3 to 7 of [`../SKILL.md`](../SKILL.md). Checked on ruff 0.17.5, basedpyright 1.40.2, import-linter 2.16, ast-grep 0.51.3 and uv 0.13.8.

## Source root and edge file

The source root is `src/<package>/` and a feature's edge file is its `__init__.py`. A runtime directory is a subpackage, such as `src/app/server/`. Runtimes that deploy apart become uv workspace members at `packages/<runtime>/src/<runtime>/`, with the contract as one more member. Re-export a feature's names from its edge file through `__all__`, which ruff and basedpyright both accept, and import those names. `from app.server.features.billing import total` records an import of `billing.total` when `total` is a module, and the boundary gate rejects it.

## Ceiling

```toml
[tool.ruff.lint]
select = ["ALL"]
ignore = [
	"COM812", # collision: ruff format writes code COM812 rejects
	"D203", # collision: D211
	"D213", # collision: D212
]
flake8-bandit.check-typed-exception = true
flake8-implicit-str-concat.allow-multiline = false
flake8-tidy-imports.ban-relative-imports = "all"
flake8-type-checking.strict = true
[tool.basedpyright]
typeCheckingMode = "all"
```

- Put this in `pyproject.toml` and pin every tool exactly in the `dev` dependency group, since `ALL` gains rules on each ruff upgrade. `ALL` holds every plugin ruff implements, framework groups such as `DJ`, `FAST` and `PD` included. Leave `preview` and `pydocstyle.convention` unset, since a convention turns off every `D` rule outside it.
- List ruff's rules with `uv run ruff rule --all --output-format json` and keep the entries whose `status` key is `Stable`, because `"preview": false` also matches removed rules. `uv run ruff check --show-settings` prints the resolved set under `linter.rules.enabled`.
- basedpyright has no command that lists rules. `all` sets every rule in the table on its configuration docs page to error, except the ones that table marks discouraged. It also ignores `# type: ignore`, so only `# pyright: ignore[rule]` suppresses.
- `CPY001` is stable and wants a `# Copyright <year> <owner>` line atop every file, empty `__init__.py` included. An SPDX line alone fails it.

## Known collisions

This is a starting list. Prove each one with a file before you turn a side off.

- `COM812` and the formatter. Format a file holding a call too long for one line, then run `ruff check --select COM812` on it. The formatter's output fails.
- `D203` and `D211`, and `D212` and `D213`. Each pair demands the opposite layout. Ruff drops `D203` and `D213` itself and warns on every run until the ledger names them.
- `ruff format --check` warns about each lint rule that conflicts with the current `[tool.ruff.format]` settings. At the defaults it names only `COM812`. Tabs add `W191` and `D206`, and single quotes add `Q000` and `Q003`.

## Boundaries

Use import-linter. For runtimes `server` and `worker` and the contract `shared`:

```toml
[tool.importlinter]
root_package = "app"
contracts = [
	{ name = "Runtimes stay apart", type = "independence", modules = [
		"app.server",
		"app.worker",
	] },
	{ name = "Features over client over primitives", type = "layers", containers = [
		"app.*",
	], layers = [
		"(features)",
		"(client)",
		"(primitives)",
	] },
	{ name = "Features meet at edge files", type = "independence", modules = [
		"app.*.features.*",
	], ignore_imports = [
		"app.*.features.** -> app.*.features.*",
	], unmatched_ignore_imports_alerting = "none" },
	{ name = "Primitives import nothing from the app", type = "forbidden", source_modules = [
		"app.*.primitives",
	], forbidden_modules = [
		"app.shared",
	] },
	{ name = "The contract imports no runtime", type = "forbidden", source_modules = [
		"app.shared",
	], forbidden_modules = [
		"app.server",
		"app.worker",
	] },
]
```

- `uv run lint-imports` exits 1 when a contract breaks. It counts imports under `if TYPE_CHECKING:`, so runtimes stay apart for types too.
- Parentheses mark a layer optional, so a runtime may lack one. The edge-file ignore needs `unmatched_ignore_imports_alerting = "none"`, or the contract fails while no feature imports another.
- For a runtime that holds its owned folders directly, put `app.<runtime>.*` in the edge-file contract, add `app.<runtime>.** -> app.<runtime>.*` to its ignores, and keep it out of the layers contract. For a single runtime, the container is `app` and the first contract goes.
- In a uv workspace, list every member in `root_packages` in place of `root_package`, and run `lint-imports` from the workspace root.

## Bans

Use ruff's `banned-api` (rule `TID251`) for the message and `per-file-ignores` for the owner. Seed bans:

```toml
[tool.ruff.lint.flake8-tidy-imports.banned-api]
"urllib.request".msg = "Call app.server.client.http.get."
"subprocess".msg = "Call app.server.client.process.run."
"os.environ".msg = "Read app.server.client.settings.SETTINGS."
"sqlite3".msg = "Call app.server.client.db.query."
"asyncio.create_task".msg = "Call app.server.client.tasks.spawn."
"datetime.datetime.now".msg = "Call app.server.primitives.clock.now."
[tool.ruff.lint.per-file-ignores]
"src/app/server/client/http.py" = ["TID251"]
```

A key matches imports and attribute access, so `os.environ.get(...)` and `datetime.now()` after `from datetime import datetime` both fail. An owner path is exempt from every ban, so give each owner its own file and list that file alone.

## Comment check

```yaml
id: no-comments
language: Python
severity: error
message: Delete this comment. Say it with a type, a test, or a lint rule.
rule:
   kind: comment
   not:
      any:
         - regex: '^#\s*(noqa|ruff:|type:|pyright:|fmt:)'
         - regex: '^#(!|\s*(-\*-\s*)?(en)?coding[:=])'
         - regex: "^#.*(Copyright|SPDX-License-Identifier)"
```

Python has one comment kind, `comment`, and each `#` line is its own node, so a license header keeps only its Copyright and SPDX lines. A docstring is a string statement and no comment node, so it passes. Add a second document after `---` that rejects a string statement anywhere else:

```yaml
id: no-string-comments
language: Python
severity: error
message: Delete this string. Only the first statement of a module, class or function is a docstring.
rule:
   kind: expression_statement
   has:
      any:
         - kind: string
         - kind: concatenated_string
   follows:
      not: { kind: comment }
      stopBy: end
```

Add `ast-grep-cli` to the `dev` group so `uv run ast-grep` runs the pinned version.

## Baseline

- basedpyright has one. `uv run basedpyright --writebaseline` writes `.basedpyright/baseline.json` and exits 1 on the run that records new errors. A normal run fails on a new error and rewrites the file when errors fall, so the check runs `git diff --exit-code .basedpyright/baseline.json` after it.
- Ruff has none, and `--add-noqa` writes suppression directives. The budget script reads `uv run ruff check --output-format json --exit-zero` and replaces `ruff check .` in the check. Each entry has `code` and `filename`, an absolute path to make relative.
- The comment check uses the budget script too. `uv run ast-grep scan --rule no-comments.yml --json=stream src tests` prints one object per line with `file` and `ruleId`, and exits 1 while matches remain.
- import-linter baselines a violation as an `ignore_imports` entry in its contract. The default alerting fails once that import is gone, so the list only shrinks.

## Check command

`uv check` runs ty, not this stack. Where the repo has no task runner, add a `Makefile` whose `check` target runs, in order: `uv run ruff format --check .`, `uv run ruff check .`, `uv run basedpyright`, `uv run lint-imports`, `uv run ast-grep scan --rule no-comments.yml src tests`, and `uv run pytest -q`. Keep gate fixtures in a top-level `gate_fixtures/`, listed in ruff's `extend-exclude` and basedpyright's `exclude`. Each gate test runs its tool on the fixture by path, such as `ruff check --select TID251 gate_fixtures/ban.py`. import-linter reads only the installed package, so the boundary test copies its fixture into `src/` and deletes it afterward.
