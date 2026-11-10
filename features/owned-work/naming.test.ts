import { expect, test } from "bun:test";

import * as Str from "effect/String";

import { cleanName } from "./naming.ts";

const message = "\n  Review main...fix-retry for correctness bugs.\nReport each with a failing input.";

const rows = [
	{ name: "a plain reply is the name", reply: "Review retry cap diff", expect: "Review retry cap diff" },
	{
		name: "quotes, markdown bold and a closing period come off",
		reply: '**"Review retry cap."**',
		expect: "Review retry cap",
	},
	{ name: "a leading name label comes off", reply: "Task name: Review retry cap", expect: "Review retry cap" },
	{
		name: "only the first non-empty line counts",
		reply: "\n Fix flaky test \nBecause it fails.",
		expect: "Fix flaky test",
	},
	{ name: "a long reply is cut to 60 chars", reply: Str.repeat(200)("x"), expect: Str.repeat(60)("x") },
	{
		name: "a reply with no letter or digit falls back to the message's first line",
		reply: "- -",
		expect: "Review main...fix-retry for correctness bugs.",
	},
];

for (const row of rows) {
	test(`naming: ${row.name}`, () => {
		expect(cleanName(message)(row.reply)).toBe(row.expect);
	});
}
