import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const draft = `## Why

The parser drops the last line of a file that has no trailing newline.

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

// A gh that serves the live body until an edit, then the body the edit sent.
const fakeGh = (sent: string) => `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const [, , , verb, ...rest] = process.argv;
const sent = ${JSON.stringify(sent)};
if (verb === "view") {
  const body = existsSync(sent) ? readFileSync(sent, "utf8") : ${JSON.stringify(live)};
  console.log(JSON.stringify({ title: "fix(parser): read the last line", body }));
} else {
  writeFileSync(sent, readFileSync(rest[rest.indexOf("--body-file") + 1], "utf8"));
  console.log("https://github.com/example/repo/pull/7");
}
`;

const published = "publish-pr: published https://github.com/example/repo/pull/7\n";

test.each([
  { flags: [], sent: live, printed: `publish-pr: kept "## Plan" from the live body\n${published}` },
  { flags: ["--replace"], sent: draft, printed: published },
])(
  "edit $flags keeps the live sections the file lacks unless --replace",
  ({ flags, sent, printed }) => {
    const dir = mkdtempSync(join(tmpdir(), "publish-pr-test-"));

    try {
      writeFileSync(join(dir, "gh"), fakeGh(join(dir, "sent.md")));
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
        printed: run.stdout.toString(),
        sent: existsSync(join(dir, "sent.md"))
          ? readFileSync(join(dir, "sent.md"), "utf8")
          : "nothing sent",
      }).toEqual({ exitCode: 0, printed, sent });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
