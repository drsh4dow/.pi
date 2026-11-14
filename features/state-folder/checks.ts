import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { actionItemProblems, type FormatProblem, linesOf, requiredLabels } from "./action-items.ts";

/** The most bytes `STATE.md` may hold, because a root takes the whole file back into context at every compaction. */
export const stateCap = 16_384;

/** A state file's check: its problems, in any order, and what to do about them. */
export interface Check {
	readonly problems: (text: string) => Effect.Effect<ReadonlyArray<FormatProblem>, never, FileSystem.FileSystem>;
	readonly fix: string;
}

const datedHeading = /^#{2,}\s.*\d{4}-\d{2}-\d{2}/u;
const newline = 10;

const bytes = (count: number) => `${count.toLocaleString("en-US")} bytes`;

/** Over the cap, one problem at the line holding the first byte past it. */
const sizeProblems = (text: string): ReadonlyArray<FormatProblem> => {
	const encoded = new TextEncoder().encode(text);

	if (encoded.length <= stateCap) {
		return [];
	}

	const line = Arr.filter([...encoded.subarray(0, stateCap)], (byte) => byte === newline).length + 1;

	return [
		{
			line,
			message: `the file is ${bytes(encoded.length)}, over the cap of ${bytes(stateCap)}, and this line crosses it`,
		},
	];
};

const datedProblems = (text: string): ReadonlyArray<FormatProblem> =>
	Arr.map(
		Arr.filter(linesOf(text).lines, ({ fenced, text: line }) => !fenced && datedHeading.test(line)),
		({ number, text: line }) => ({
			line: number,
			message: `"${line}" is a dated section. Dated history goes to decisions.tsv`,
		}),
	);

/** One check per state file, keyed by file name. Adding a file adds a row. */
export const checks = new Map<string, Check>([
	[
		"STATE.md",
		{
			problems: (text) => Effect.succeed([...sizeProblems(text), ...datedProblems(text)]),
			fix: `STATE.md holds at most ${bytes(stateCap)}, because you take the whole file back at every compaction. It keeps the destination, the human's standing instructions, the decisions in force, the status and the next step. Dated history and settled decisions go to the decision trail, decisions.tsv.`,
		},
	],
	[
		"USER_ACTION_ITEMS.md",
		{
			problems: (text) => Effect.succeed(actionItemProblems(text)),
			fix: `The format is in the USER_ACTION_ITEMS.md bullet of ~/.pi/agent/roles/root.md: each item is a "## <title>" line, then a line starting with each of ${Arr.join(requiredLabels, ", ")}.`,
		},
	],
]);
