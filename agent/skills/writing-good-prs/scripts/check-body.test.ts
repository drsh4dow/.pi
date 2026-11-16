import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const diff = `## What changed

\`\`\`diff
- return lines.slice(0, -1);
+ return lines;
\`\`\`

`;

const prBody = (whatChanged: string, tail = "") => `## Why

The parser drops the last line of a file that has no trailing newline.

${whatChanged}## Scope

Covers the parser only.

## Blast Radius

Callers of the parser. A two-way door.

## Verification

- **The last line is read.** \`0 lines\` → \`1 line\`.

**Not checked:** nothing.
${tail}`;

const evidence = `
## Evidence

<details><summary>Parser run</summary>

\`\`\`text
1 line
\`\`\`

</details>
`;

const lines = (count: number, text: string) =>
  Array.from({ length: count }, (_, index) => `${text} ${index + 1}.\n`).join("");

const bugTemplate = `## What happens

Actual behavior.

## What should happen

Expected behavior.

## Steps to reproduce

1. 

## Impact

Who is affected and how many. Does it touch billing, claims, or patient data?

## Evidence

Datadog link, support ticket, screenshot.

## Acceptance criteria

- [ ] Fixed, and a regression test covers it

+++ Agent notes

Root cause, files, logs.

+++
`;

const taskTemplate = `## Why

One or two sentences: what this unlocks, tied to the project or milestone.

## What

The change, described as behavior someone can observe, not as implementation.

## Acceptance criteria

- [ ] Testable statement
- [ ] Testable statement

## Out of scope

What this issue deliberately doesn't do (each item becomes its own issue if needed).

+++ Agent notes

Implementation plan, files, commands, logs.

+++
`;

const impact = `## Impact

Every biller who pastes long notes, about 40 claims a week. It touches claims.

`;

const bugAgentNotes = `+++ Agent notes

The notes column is varchar(4000).

+++
`;

const bugBody = `## What happens

Saving a claim with a 5,000 character note returns a 500.

## What should happen

The claim saves and keeps the whole note.

## Steps to reproduce

1. Open a claim.
2. Paste a 5,000 character note and save.

${impact}## Evidence

Datadog trace: https://app.datadoghq.com/apm/trace/123

## Acceptance criteria

- [ ] Fixed, and a regression test covers it

${bugAgentNotes}`;

const taskAgentNotes = `+++ Agent notes

Add a cursor to the export query.

+++
`;

const notesForAgents = `# Notes for agents

Run the export against staging before review.
`;

const taskBody = (end: string) => `## Why

Finance needs exports over 10,000 rows for the quarter close.

## What

An export of any size downloads as one CSV.

## Acceptance criteria

- [ ] A 50,000 row export downloads whole

## Out of scope

Excel output.

${end}`;

const ui = (paths: string) => ({ "--changed-files": paths });

function check(kind: string, body: string, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-body-test-"));

  try {
    writeFileSync(join(dir, "body.md"), body);

    const flags = Object.entries(files).flatMap(([flag, content], index) => {
      writeFileSync(join(dir, `${index}.txt`), content);
      return [flag, join(dir, `${index}.txt`)];
    });
    const run = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "check-body.ts"),
      kind,
      join(dir, "body.md"),
      ...flags,
    ]);

    return { exitCode: run.exitCode, printed: run.stdout.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.each([
  { name: "a PR with a diff and its Evidence in <details>", body: prBody(diff, evidence) },
  {
    name: "a PR whose What changed holds only an image",
    body: prBody("## What changed\n\n![Parser call tree](https://example.com/tree.png)\n\n"),
  },
  {
    name: "a PR of 45 lines with 20 inside <details>",
    body: prBody(
      diff,
      `## Evidence\n<details><summary>Parser run</summary>\n${lines(18, "Output line")}</details>\n`,
    ),
  },
  {
    name: "a PR changing a .tsx file with a Before | After table",
    body: prBody(
      diff,
      "\n| Before | After |\n| --- | --- |\n| ![before](https://example.com/b.png) | ![after](https://example.com/a.png) |\n",
    ),
    files: ui("src/App.tsx\n"),
  },
  {
    name: "a PR changing a .tsx file that names the missing screenshots",
    body: prBody(diff).replace(
      "**Not checked:** nothing.",
      "**Not checked:** screenshots, because the dev server needs production keys.",
    ),
    files: ui("src/App.tsx\n"),
  },
  {
    name: "a PR changing only a .ts file without a table",
    body: prBody(diff),
    files: ui("src/server.ts\n"),
  },
  {
    name: "a ticket filling ENG: Bug",
    kind: "ticket",
    body: bugBody,
    files: { "--template": bugTemplate },
  },
  {
    name: "a ticket filling ENG: Task with a trailing # Notes for agents",
    kind: "ticket",
    body: taskBody(`${taskAgentNotes}\n${notesForAgents}`),
    files: { "--template": taskTemplate },
  },
])("passes $name", ({ kind = "pr", body, files }) => {
  expect(check(kind, body, files)).toEqual({ exitCode: 0, printed: "" });
});

test.each([
  {
    name: "a PR without What changed",
    body: prBody(""),
    finding: 'body.md:1: missing "## What changed"',
  },
  {
    name: "a PR whose What changed is prose only",
    body: prBody("## What changed\n\nThe parser keeps the last line.\n\n"),
    finding: 'body.md:5: "## What changed" has no visual',
  },
  {
    name: "a PR of 41 lines outside <details>",
    body: prBody(
      diff,
      `<details><summary>Log</summary>\n\nOutput.\n\n</details>\n${lines(17, "Context line")}`,
    ),
    finding: "body.md:46: body has 41 visible lines outside <details>",
  },
  {
    name: "a PR with an Evidence line outside <details>",
    body: prBody(diff, evidence.replace("\n<details>", "\nThe parser log.\n\n<details>")),
    finding: 'body.md:28: "## Evidence" has lines outside <details>',
  },
  {
    name: "a PR with an empty Evidence",
    body: prBody(diff, "\n## Evidence\n"),
    finding: 'body.md:26: "## Evidence" has lines outside <details>',
  },
  {
    name: "a PR changing a .tsx file without a table",
    body: prBody(diff),
    files: ui("src/App.tsx\n"),
    finding: "body.md:1: the PR changes UI files (src/App.tsx) but has no",
  },
  {
    name: "an ENG: Bug ticket without Impact",
    kind: "ticket",
    body: bugBody.replace(impact, ""),
    files: { "--template": bugTemplate },
    finding: 'body.md:1: missing "## Impact"',
  },
  {
    name: "an ENG: Bug ticket without the Agent notes block",
    kind: "ticket",
    body: bugBody.replace(bugAgentNotes, ""),
    files: { "--template": bugTemplate },
    finding: 'body.md:1: missing "+++ Agent notes"',
  },
  {
    name: "an ENG: Task ticket with # Notes for agents before the Agent notes block",
    kind: "ticket",
    body: taskBody(`${notesForAgents}\n${taskAgentNotes}`),
    files: { "--template": taskTemplate },
    finding: '"+++ Agent notes" is out of order or repeated',
  },
  {
    name: "a ticket with # Notes for agents and no template",
    kind: "ticket",
    body: `## Problem\n\nExports over 10,000 rows fail.\n\n## Done when\n\n- [ ] A 50,000 row export downloads whole\n\n${notesForAgents}`,
    finding: 'body.md:9: unexpected heading "# Notes for agents"',
  },
])("fails $name", ({ kind = "pr", body, files, finding }) => {
  const { exitCode, printed } = check(kind, body, files);

  expect(printed).toContain(finding);
  expect(exitCode).toBe(1);
});
