import { expect, test } from "bun:test";

import * as Arr from "effect/Array";

import { changesOf, judge } from "./untouched.ts";

const session = "/h/.pi/agent/sessions/--p--/s.jsonl";
const state = "/h/.local/state/pi-agent/p/w/STATE.md";

const rows = [
	{
		name: "a file gone after the run counts against it, whatever path removed it",
		before: [[state, "6 1.0"]],
		after: [],
		headers: [],
		expected: [["deleted", state, false]],
	},
	{
		name: "a changed state file counts against the run",
		before: [[state, "6 1.0"]],
		after: [[state, "6 2.0"]],
		headers: [],
		expected: [["changed", state, false]],
	},
	{
		name: "a session file of a session the run never ran is cleared",
		before: [[session, "10 1.0"]],
		after: [[session, "20 2.0"]],
		headers: [[session, "human"]],
		expected: [["changed", session, true]],
	},
	{
		name: "a session file of a session the run ran counts against it",
		before: [],
		after: [[session, "20 2.0"]],
		headers: [[session, "run"]],
		expected: [["new", session, false]],
	},
	{
		name: "a session file with no header after the run counts against it",
		before: [[session, "10 1.0"]],
		after: [[session, "0 2.0"]],
		headers: [],
		expected: [["changed", session, false]],
	},
	{
		name: "a file with the same size and change time is no change",
		before: [[state, "6 1.0"]],
		after: [[state, "6 1.0"]],
		headers: [],
		expected: [],
	},
] satisfies ReadonlyArray<{
	readonly name: string;
	readonly before: ReadonlyArray<readonly [string, string]>;
	readonly after: ReadonlyArray<readonly [string, string]>;
	readonly headers: ReadonlyArray<readonly [string, string]>;
	readonly expected: ReadonlyArray<readonly [string, string, boolean]>;
}>;

for (const { name, before, after, headers, expected } of rows) {
	test(`untouched: ${name}`, () => {
		const changes = changesOf({ before: new Map(before), after: new Map(after) });
		const judged = judge({ changes, headers: new Map(headers), recorded: new Set(["run"]) });

		expect(Arr.map(judged, ({ kind, path, cleared }) => [kind, path, cleared])).toEqual(expected);
	});
}
