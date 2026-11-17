import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";

import { StateFolder } from "#src/client/state-folder/index.ts";
import {
	actionItemProblems,
	type FormatProblem,
	linesOf,
	onlyYouKinds,
	onlyYouLabel,
	onlyYouReasons,
	requiredLabels,
} from "./action-items.ts";

const stateCap = 16_384;

export interface Place {
	readonly home: string;
	readonly folder: string;
}

export interface Check {
	readonly problems: (
		file: Uint8Array,
		place: Place,
	) => Effect.Effect<ReadonlyArray<FormatProblem>, never, StateFolder>;
	readonly fix: string;
}

const datedHeading = /^#{2,}\s.*\d{4}-\d{2}-\d{2}/u;
const newline = 10;

const bytes = (count: number) => `${count.toLocaleString("en-US")} bytes`;

const textOf = (file: Uint8Array) => new TextDecoder().decode(file);

const sizeProblems = (file: Uint8Array): ReadonlyArray<FormatProblem> => {
	if (file.length <= stateCap) {
		return [];
	}

	const line = Arr.filter([...file.subarray(0, stateCap)], (byte) => byte === newline).length + 1;

	return [
		{
			line,
			message: `the file is ${bytes(file.length)}, over the cap of ${bytes(stateCap)}, and this line crosses it`,
		},
	];
};

const datedProblems = (text: string) =>
	Arr.map(
		Arr.filter(linesOf(text).lines, ({ text: line, fenced }) => !fenced && datedHeading.test(line)),
		({ number, text: line }): FormatProblem => ({
			line: number,
			message: `"${Str.trim(line)}" heads a dated section. Dated history goes to decisions.tsv`,
		}),
	);

const resolvePath = (path: string, { home, folder }: Place) => {
	if (Str.startsWith("~/")(path)) {
		return `${home}/${Str.slice(2)(path)}`;
	}

	return Str.startsWith("/")(path) ? path : `${folder}/${path}`;
};

const actionItemsProblems = Effect.fn("actionItemsProblems")(function* (file: Uint8Array, place: Place) {
	const stateFolder = yield* StateFolder;
	const text = textOf(file);
	const { problems, denials } = onlyYouReasons(text);

	const isFile = (path: string) => stateFolder.isFile(resolvePath(path, place));

	const missing = yield* Effect.filter(denials, ({ paths }) =>
		Effect.map(Effect.forEach(paths, isFile), (found) => !Arr.contains(found, true)),
	);

	const uncited = Arr.map(missing, ({ line, paths }) => ({
		line,
		message: `no text between backticks on the line names an existing file: ${Arr.join(
			Arr.map(paths, (path) => resolvePath(path, place)),
			", ",
		)}`,
	}));

	return [...actionItemProblems(text), ...problems, ...uncited];
});

export const checks = new Map<string, Check>([
	[
		"STATE.md",
		{
			problems: (file) => Effect.succeed([...sizeProblems(file), ...datedProblems(textOf(file))]),
			fix: `STATE.md holds at most ${bytes(stateCap)}, because you take the whole file back at every compaction. It keeps the destination, the human's standing instructions, the decisions in force, the status and the next step. Dated history and settled decisions go to the decision trail, decisions.tsv.`,
		},
	],
	[
		"USER_ACTION_ITEMS.md",
		{
			problems: actionItemsProblems,
			fix: `The format is in the USER_ACTION_ITEMS.md bullet of ~/.pi/agent/roles/root.md: each item is a "## <title>" line, then a line starting with each of ${Arr.join([...requiredLabels, onlyYouLabel], ", ")}. The ${onlyYouLabel} line names why only the human can act: ${Arr.join(onlyYouKinds, ", ")}. An access line cites, in backticks, the file that records the denied attempt.`,
		},
	],
]);
