import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const draft = `## Why

The parser drops the last line of a file that has no trailing newline.

## What changed

\`\`\`diff
- return lines.slice(0, -1);
+ return lines;
\`\`\`

## Scope

Covers the parser only.

## Blast Radius

Callers of the parser. A two-way door.

## Verification

- **The last line is read.** \`0 lines\` → \`1 line\`.

**Not checked:** nothing.
`;

const live = `${draft}
## Plan

A section a bot appended.
`;

const fakeGh = (sent: string, files: string) => `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const [, , , verb, ...rest] = process.argv;
const sent = ${JSON.stringify(sent)};
if (verb === "view" && rest[rest.indexOf("--json") + 1] === "files") {
  process.stdout.write(${JSON.stringify(files)});
} else if (verb === "view") {
  const body = existsSync(sent) ? readFileSync(sent, "utf8") : ${JSON.stringify(live)};
  console.log(JSON.stringify({ title: "fix(parser): read the last line", body }));
} else {
  writeFileSync(sent, readFileSync(rest[rest.indexOf("--body-file") + 1], "utf8"));
  console.log("https://github.com/example/repo/pull/7");
}
`;

const published = "publish-pr: published https://github.com/example/repo/pull/7\n";

test.each([
  {
    name: "keeps the live sections the file lacks",
    flags: [],
    files: "src/parser.ts\n",
    exitCode: 0,
    sent: live,
    printed: `publish-pr: kept "## Plan" from the live body\n${published}`,
  },
  {
    name: "with --replace sends the file as is",
    flags: ["--replace"],
    files: "src/parser.ts\n",
    exitCode: 0,
    sent: draft,
    printed: published,
  },
  {
    name: "sends nothing when a changed UI file has no Before | After table",
    flags: [],
    files: "src/parser.ts\nweb/Button.tsx\n",
    exitCode: 1,
    sent: "nothing sent",
    printed: `<dir>/body.md:1: the PR changes UI files (web/Button.tsx) but has no "| Before | After |" table or "**Not checked:**" line naming the missing screenshots\n`,
  },
])("edit $name", ({ flags, files, exitCode, sent, printed }) => {
  const dir = mkdtempSync(join(tmpdir(), "publish-pr-test-"));

  try {
    writeFileSync(join(dir, "gh"), fakeGh(join(dir, "sent.md"), files));
    chmodSync(join(dir, "gh"), 0o755);
    writeFileSync(join(dir, "body.md"), draft);

    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "publish-pr.ts"),
        "edit",
        "7",
        join(dir, "body.md"),
        "--title",
        "fix(parser): read the last line",
        ...flags,
      ],
      { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
    );

    expect({
      exitCode: run.exitCode,
      printed: run.stdout.toString().replaceAll(dir, "<dir>"),
      sent: existsSync(join(dir, "sent.md"))
        ? readFileSync(join(dir, "sent.md"), "utf8")
        : "nothing sent",
    }).toEqual({ exitCode, printed, sent });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
