import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { stdoutRedirectOf } from "./redirect.ts";

const shown = Option.none();

const rows: ReadonlyArray<{ readonly command: string; readonly expect: Option.Option<string> }> = [
	{
		command: "bun run check > /tmp/check.log 2>&1; echo exit=$?",
		expect: Option.some("/tmp/check.log"),
	},
	{ command: "cmd >/dev/null 2>&1", expect: Option.some("/dev/null") },
	{ command: "bun test &> out.log", expect: Option.some("out.log") },
	{ command: "cd web && bun run build 1>>build.log", expect: Option.some("build.log") },
	{ command: "bun test 2>&1", expect: shown },
	{ command: "cmd 2>/dev/null", expect: shown },
	{ command: "echo failed >&2; exit 1", expect: shown },
	{ command: "cmd | tee out.log", expect: shown },
	{ command: `bun -e 'console.log([1].map((n) => n > 0))'`, expect: shown },
	{ command: `bun test > "$LOG"`, expect: Option.some('"$LOG"') },
	{ command: String.raw`set -C; printf 'hidden\n' >| force.log`, expect: Option.some("force.log") },
	{ command: String.raw`echo result \> baseline`, expect: shown },
	{ command: String.raw`printf 'visible\n' # prior run > old.log`, expect: shown },
	{ command: "echo ' # not a comment' > kept.log", expect: Option.some("kept.log") },
];

const cases = Arr.map(rows, (row) => ({
	...row,
	outcome: Option.match(row.expect, { onNone: () => "shows its output", onSome: (to) => `sends it to ${to}` }),
}));

test.each(cases)("`$command` $outcome", ({ command, expect: expected }) => {
	expect(stdoutRedirectOf(command)).toEqual(expected);
});
