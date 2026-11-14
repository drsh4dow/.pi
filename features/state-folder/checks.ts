import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { marked } from "marked";

import {
	actionItemProblems,
	type FormatProblem,
	onlyYouKinds,
	onlyYouLabel,
	onlyYouReasons,
	requiredLabels,
} from "./action-items.ts";

/** The most bytes `STATE.md` may hold, because a root takes the whole file back into context at every compaction. */
export const stateCap = 16_384;

/** Where a changed state file lives, which a check resolves the paths it cites against. */
export interface Place {
	readonly home: string;
	readonly folder: string;
}

/** A state file's check: its problems, in any order, and what to do about them. */
export interface Check {
	readonly problems: (
		text: string,
		place: Place,
	) => Effect.Effect<ReadonlyArray<FormatProblem>, never, FileSystem.FileSystem>;
	readonly fix: string;
}

const isoDate = /\d{4}-\d{2}-\d{2}/u;
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

/** A block of Markdown as the parser reads it, with the blocks or list items nested in it. */
interface Block {
	readonly raw: string;
	readonly type: string;
	readonly depth?: number;
	readonly text?: string;
	readonly tokens?: ReadonlyArray<Block>;
	readonly items?: ReadonlyArray<Block>;
}

const Nested = Schema.Array(Schema.suspend((): Schema.Codec<Block> => Block));

const Block = Schema.Struct({
	raw: Schema.String,
	type: Schema.String,
	depth: Schema.optionalKey(Schema.Finite),
	text: Schema.optionalKey(Schema.String),
	tokens: Schema.optionalKey(Nested),
	items: Schema.optionalKey(Nested),
});

const decodeBlocks = Schema.decodeUnknownEffect(Schema.Array(Block));

/** The text of each heading of level 2 or deeper in a block, nested ones included, that holds an ISO date. */
const datedHeadings = ({ type, depth = 0, text = "", tokens = [], items = [] }: Block): ReadonlyArray<string> => {
	if (type === "heading") {
		return depth >= 2 && isoDate.test(text) ? [text] : [];
	}

	return Arr.flatMap([...tokens, ...items], datedHeadings);
};

/**
 * Each dated section, read by a Markdown parser, so a fence, indented code, a quote or a list puts a line where Markdown
 * puts it. The parser's top-level blocks together hold the whole text, which places each heading on its line.
 */
const datedProblems = Effect.fn("datedProblems")(function* (text: string) {
	const source = Str.replaceAll(/\r\n?/gu, "\n")(text);
	const blocks = yield* Effect.orDie(decodeBlocks(marked.lexer(source)));
	const starts = Arr.scan(blocks, 0, (offset, { raw }) => offset + raw.length);

	return Arr.flatMap(blocks, (block, index) =>
		Arr.map(datedHeadings(block), (heading): FormatProblem => {
			const start = starts[index] ?? 0;
			const within = Str.indexOf(heading)(Str.slice(start)(source));
			const at = start + Option.getOrElse(within, () => 0);

			return {
				line: Str.split("\n")(Str.slice(0, at)(source)).length,
				message: `"${heading}" heads a dated section. Dated history goes to decisions.tsv`,
			};
		}),
	);
});

/** A cited path as the file system sees it: `~/` is home, an absolute path stays, any other is in the state folder. */
const resolvePath = (path: string, { home, folder }: Place) => {
	if (Str.startsWith("~/")(path)) {
		return `${home}/${Str.slice(2)(path)}`;
	}

	return Str.startsWith("/")(path) ? path : `${folder}/${path}`;
};

const actionItemsProblems = Effect.fn("actionItemsProblems")(function* (text: string, place: Place) {
	const fs = yield* FileSystem.FileSystem;
	const { problems, denials } = onlyYouReasons(text);

	const missing = yield* Effect.forEach(denials, ({ line, path }) => {
		const resolved = resolvePath(path, place);

		return Effect.map(
			fs.stat(resolved).pipe(
				Effect.map(({ type }) => type === "File"),
				Effect.orElseSucceed(() => false),
			),
			(isFile): ReadonlyArray<FormatProblem> =>
				isFile ? [] : [{ line, message: `the cited file ${resolved} does not exist or is not a file` }],
		);
	});

	return [...actionItemProblems(text), ...problems, ...Arr.flatten(missing)];
});

/** One check per state file, keyed by file name. Adding a file adds a row. */
export const checks = new Map<string, Check>([
	[
		"STATE.md",
		{
			problems: (text) => Effect.map(datedProblems(text), (dated) => [...sizeProblems(text), ...dated]),
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
