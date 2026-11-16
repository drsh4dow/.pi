---
name: dunify
description: Set up a new codebase in the Dune style, or move an existing one toward it, so its layout and its checks constrain what an agent can write.
disable-model-invocation: true
for: [root]
---

# Dunify

Change the repo so that the shortest path an agent can take is the correct one. Dune, the Grok Bot team's client framework, gets there with two things, and you install both: a **layout** whose folder names carry rules, and a **ceiling** of checks that reject everything else.

Judge every choice below against Dune's five rules:

1. The conventional path requires fewer decisions than a shortcut.
2. Forbidden dependencies fail mechanically.
3. Every durable value has one obvious writer.
4. New product work adds isolated files rather than branches in shared roots.
5. Exceptions are narrow, explicit, and reviewed as architecture changes.

## The layout

A **runtime directory** is named for where its code runs, such as `electron-main`, `server` or `worker`. It sits inside the language's source root. A project with one runtime uses the source root itself. Runtime directories never import each other, types included.

The **contract** is `shared/`, beside the runtime directories. It appears with the second runtime. It holds types and schemas and no logic, one edge file per contract, with typed arguments and typed failures. It is the only thing two runtime directories both import.

Inside a runtime directory there are three names. A runtime carries only the ones it needs.

| Name               | Job                                                                                                                                                         | Imports                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `features/<name>/` | One owned folder for one piece of product work. Its edge file is the only file another feature may import.                                                  | Its own files, another feature's edge file, `client/`, `primitives/`, `shared/` |
| `client/`          | The one writer of each durable value, and the only code that crosses a boundary to another runtime or an outside system. Features call its named functions. | Its own files, `primitives/`, `shared/`                                         |
| `primitives/`      | Building blocks that know no feature and own no state.                                                                                                      | Its own files, nothing else from the app                                        |

A runtime with neither `client/` nor `primitives/` holds its owned folders directly, with no `features/` level.

Dune's tree is the worked example:

```
src/
  electron-renderer/
    features/reports/index.ts
    client/reports-store.ts
    primitives/
  electron-main/
    startup/
    notifications/
    update/
  shared/reports-rpc.ts
```

A runtime's **entry file** sits at the root of its runtime directory. It starts the runtime and may import anything inside it. A noun that fits none of the three names, such as a migration or a scheduled job, enters through the layout map with a row of its own. Files outside the source root, such as tool configs, scripts and gate fixtures, are outside the map.

## The ceiling

The **ceiling** is every stable lint group at error, every plugin that fits the stack, the type checker's strictest mode, and the formatter in check mode. It includes the groups whose own docs say to hand-pick from them, such as `restriction` in oxlint and clippy. Unfinished groups, such as nursery and preview, stay off as a group.

A rule goes off in one of two ways:

- A **collision** is two rules, or a rule and the formatter or compiler, that no spelling of a construct can satisfy together. Write each spelling, run the tools on them, and when every one fails a side, turn one side off yourself. A pair that only forbids the construct is a ban, so it goes to the user.
- Every other rule you want off goes to the user in one list, with what it flags here and your pick. It stays on until they answer. An option that narrows a rule and a suppression directive in a source file are each a rule turned off, so they go in the same list.

The linter's config is the **ledger**. Each rule that is off carries a one-line reason beside it, which names the collision pair or the user's approval.

No linter ships these three gates, so you build them:

- **Boundaries** reject every import the layout map does not allow.
- **Bans** reject an API that takes judgment to use well, such as an effect hook, a raw timer or a transport call. Each ban names one **owner**, the single file or folder allowed to use the API, and its message names the function to call instead. Write that function in the owner before you add the ban. A ban holds inside its owner's runtime directory, so its message never points across a boundary.
- **The comment check** rejects every comment in a source file except a doc comment on a declaration, a license header and a tool directive. Config files are exempt.

## Steps

### 1. Read the repo

For a new repo, ask the user for the language, the app kind, and any framework they have already picked. Pick none yourself. Stop until they answer.

Read the reference for each language the repo uses: [`references/typescript.md`](references/typescript.md), [`references/effect.md`](references/effect.md) when `effect` is a dependency, [`references/rust.md`](references/rust.md), [`references/python.md`](references/python.md), and [`references/other.md`](references/other.md) for any other language.

For an existing repo, measure before you read. Get each of these from a command:

- the lines of source per build module or top-level folder, without tests and generated code;
- the edges between those modules that production code uses, from the build tool or an import graph;
- the commits of the last 90 days per module;
- the build and test commands CI runs, whether each passes on the untouched tree, and how long each takes.

Stop and tell the user when the build or the tests fail or cannot run on this machine, since no move can be checked against a red tree. A green CI run of the same commit counts as a pass.

Past about 20,000 lines of source, one agent cannot read the repo and one branch cannot carry the change. Read [`references/large-repo.md`](references/large-repo.md) now and follow it through every step.

Then list with paths:

- each place code runs;
- each durable value, such as a store, a table, a cache or a file, and every place that writes it;
- each registry, meaning a file that every new feature of one kind must edit;
- the check command, the CI config, the linter, type checker and formatter configs, and every rule already off.

Done when the user has answered for a new repo, or every runtime, durable value, registry and gate config of an existing repo is named.

### 2. Draw the layout map and get it approved

Write the **layout map**, one row per noun:

| Noun | Place | Job | Writer | Imports |
| ---- | ----- | --- | ------ | ------- |

Give a row to each runtime directory, its entry file, each feature, each file in `client/` with the value or system it owns, `primitives/`, each contract edge, and each noun of the project's own.

Under the map, list:

- **The bans**, each with its API, its owner and its message. For an existing repo, seed them from mistakes that happened twice, found the way the **correct** skill finds mistake classes, and then from the language reference. For a new repo, seed them from the language reference. Propose a ban only for an API the code calls today or the first feature will call, so every owner has a caller. A mistake that is a missing call is no ban. List it under the five rules as a gap.
- **The hot spots**, one per registry. Where the stack discovers files in one line, such as a glob import, plan to replace the registry with it. A registry stays when the compiler rejects a missing entry, or when the stack has no such discovery, and is named here.
- **The five rules**, each with the row or gate that upholds it. A rule with none is a gap, and you say so.

Show all of it to the user and stop. Done when the user approves the map and the bans.

### 3. Move files

For an existing repo, move each file whose whole content belongs to one row, one commit per runtime directory, with the repo's build and tests passing after each. A file that mixes two rows stays where it is and goes on the cleanup plan.

For a new repo, create the tree and write one small feature that calls `client/`, and that crosses a contract edge when there are two runtimes. Later features copy it, so it passes every gate before you hand back.

Done when every file is in its row's place or on the cleanup plan.

### 4. Raise the ceiling

Follow each language reference. List the rules from the installed tool, since any list written down is already stale. Turn everything on. Settle each collision with files that prove it, kept outside the repo, before any auto-fix runs, since a fix settles a collision by deleting code. Then send the user the one list of every other rule you want off. Stop until they answer.

Done when every stable rule is on, and every rule that is off has its line in the ledger.

### 5. Build the three gates

Build boundaries and bans with the tools the language reference names. Build the comment check as an ast-grep rule, shaped like this one for TypeScript:

```yaml
id: no-comments
language: TypeScript
severity: error
message: Delete this comment. Say it with a type, a test, a lint rule, or a doc comment on the declaration.
rule:
   kind: comment
   not:
      any:
         - all:
              - regex: '^/\*\*[^*]'
              - not: { inside: { kind: statement_block } }
              - precedes: { not: { any: [kind: expression_statement, kind: comment] }, stopBy: neighbor }
         - regex: '^(//|/\*)\s*(oxlint|oxfmt)-'
         - all:
              - regex: '^(//|/\*)[\s\S]*(Copyright|SPDX-License-Identifier)'
              - inside: { kind: program }
              - not: { follows: { not: { any: [kind: comment, kind: hash_bang_line] }, stopBy: end } }
```

`ast-grep scan --rule <file> <source root>` exits 1 on a match. The first exclusion lets a doc comment pass when it sits before a declaration and outside a function body. The last lets a license header pass only at the top of the file. The language reference gives the `language`, the comment kinds, the doc comment form and the directive patterns.

Every message names the owner or the function to use. For each gate, write a fixture that breaks it and a test that expects the gate to fail on the fixture. Keep both, with the fixtures outside every path the check scans. Where a gate matches by path, the test copies the fixture into that path and removes it afterward.

Done when each gate has failed on its fixture in a real run, with its message in the output.

### 6. Record the baseline

Skip this step for a new repo.

Run every auto-fix. A fix that trips another rule is a collision, so settle it as in step 4. Then record a **baseline**, a committed count of the violations left, per file and rule, that may only fall. Use the tool's own baseline where the language reference names one. Where it names none, write a budget script in the project's language:

- it reads the tool's JSON output and counts violations per file and rule;
- it fails when any count is above the committed one;
- it fails when a count is below the committed one, and tells the reader to commit the lower count.

The baseline replaces suppression directives. Write none. Existing comments get the same treatment: count them in the baseline, and leave their removal to the **no-comments** skill.

Done when the check passes on the untouched repo and fails after you add one violation of a baselined rule.

### 7. Wire one check command

Make one `check` command that runs the formatter in check mode, the linter, the type checker, the three gates, the baseline and the tests. Add a CI job that runs the same command when the repo already has CI.

Write two files with the **writing-for-agents** skill:

- `AGENTS.md` holds the check command and one line that says when to read `CODING_STANDARDS.md`.
- `CODING_STANDARDS.md` holds one table that pairs each rule with the gate that enforces it, then the rules that need judgment and so have no gate.

When an `AGENTS.md` already exists, move its instructions into `CODING_STANDARDS.md`, and delete each line that a gate now enforces or that a config file already states.

Done when `check` exits 0 on a clean checkout after its install step, and the work is committed.

### 8. Hand back

Put the **cleanup plan** in the reply: each baselined rule with its count, and each file that mixes two rows. Rank boundary and ban violations first, since the next agent copies what it finds, then type-safety rules, then style.

Name the next steps by skill: **no-comments** to remove the existing comments, **correct** whenever the user corrects an agent, and **create-verification-skill** to prove behavior at runtime.

**Reply:** the layout map as approved, the ledger with each reason, the baseline counts, the cleanup plan, and the hot spots still open.
