# Any other language

The dunify reference for a language that has no file of its own. Answer each question below from the tools' docs and from a real run, then use the answers in the steps of [`../SKILL.md`](../SKILL.md).

## Source root and edge file

- Which directory do the language's build tools treat as the source root? Runtime directories go inside it.
- Which file makes a folder importable as one unit, the way `index.ts` or `mod.rs` does? That is a feature's edge file.

## Ceiling

- **Linter.** Find the switch that turns on every rule or every group, and list the groups from the installed tool. Leave off only a group the tool itself calls unfinished.
- **Inner switches.** A linter that bundles other linters often keeps each one's rules behind its own switch. Turn those on too.
- **Type checker.** Use its strictest mode. Where two checkers exist, pick the one whose strictest mode reports more on this repo, measured by running both.
- **Formatter.** Run it in check mode.

## Known collisions

Start from the linter's own page on formatter conflicts and on rules that oppose each other. Each entry there is a candidate. It becomes a collision when a file proves it.

## Boundaries

Prefer a tool that checks resolved import edges between directories. Where the language has none, use the compiler's own visibility, such as a package per runtime directory, and an ast-grep rule on import statements for the edges visibility cannot express.

## Bans

Use the linter's banned-API setting when it carries a custom message. Otherwise write an ast-grep rule per ban, scoped to every path except the owner.

## Comment check

Set `language` in the rule from `SKILL.md`. To find what the grammar calls a comment, give ast-grep a comment as the pattern: `ast-grep run --pattern '// x' --lang <language> --debug-query=cst .` prints the node kind. Repeat it for each comment form the language has, since some grammars use one kind for line comments and another for block comments. Add a `regex` exclusion for each tool directive the stack uses. Let the language's doc comment form pass where its doc tool reads it, and reject that form anywhere else.

## Baseline

Check the linter and the type checker for a baseline file or a mode that reports only new violations. A mode that filters by changed lines misses a violation outside the diff, so prefer a baseline file. Where neither exists, write the budget script from `SKILL.md`.

## Check command

Use the task runner the repo already has. Where it has none, use the language's most common one.
