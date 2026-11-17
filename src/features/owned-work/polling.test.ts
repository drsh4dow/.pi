import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { warnedResult } from "./polling.ts";
import { WorkRef } from "./work.ts";

const held = [WorkRef("watch-2"), WorkRef("delegate-1")];

const warning = "watch-2, delegate-1 will wake you. End your turn to wait.";

const call = (toolName: string, command: string) => ({
	toolName,
	input: { command },
	content: [{ type: "text" as const, text: "done" }],
	structuredContent: { output: "done", exit_code: 0 },
});

const warned = Option.some({
	content: [
		{ type: "text", text: "done" },
		{ type: "text", text: warning },
	],
	structuredContent: { output: `done\n${warning}`, exit_code: 0 },
});

const rows = [
	{ tool: "bash", command: "sleep 30", waking: held, expect: warned },
	{ tool: "codemode", command: "sleep 30", waking: held, expect: Option.none() },
	{ tool: "bash", command: "bun test; sleep 600 && cat out.log", waking: held, expect: warned },
	{ tool: "bash", command: "sleep 45s", waking: held, expect: warned },
	{ tool: "bash", command: "sleep 29", waking: held, expect: Option.none() },
	{ tool: "bash", command: "sleep 5; sleep 10", waking: held, expect: Option.none() },
	{ tool: "bash", command: "nosleep 60", waking: held, expect: Option.none() },
	{ tool: "bash", command: "sleep 30", waking: [], expect: Option.none() },
];

const cases = Arr.map(rows, (row) => ({
	...row,
	jobs: `${String(row.waking.length)} jobs`,
	outcome: Option.isSome(row.expect) ? "warns" : "does not warn",
}));

test.each(cases)("$tool `$command` while $jobs run $outcome", (row) => {
	expect<Option.Option<unknown>>(warnedResult(row.waking)(call(row.tool, row.command))).toEqual(row.expect);
});
