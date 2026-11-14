import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";

export interface FormatProblem {
	readonly line: number;
	readonly message: string;
}

export const requiredLabels = [
	"**The call.**",
	"**My pick.**",
	"**What it changes.**",
	"**Evidence.**",
	"**Risk.**",
] as const;

export const onlyYouLabel = "**Only you.**";

export const onlyYouKinds = ["decision", "approval", "irreversible action", "access"] as const;

/** A file an access item cites as the record of the denied attempt, and its line. */
export interface Denial {
	readonly line: number;
	readonly path: string;
}

interface Line {
	readonly number: number;
	readonly text: string;
	readonly fenced: boolean;
}

interface Fence {
	readonly line: number;
	readonly marker: string;
}

interface Item {
	readonly title: string;
	readonly line: number;
	readonly body: Array<Line>;
}

const fenceLine = /^\s*(?<marker>`{3,}|~{3,})\s*(?<info>.*)$/u;
const itemContent = /^\s*(?:[-*+]|\d+[.)])\s|^\s*\*\*|^#|^\s*(?:`{3}|~{3})/u;
const listMarker = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?/u;
const onlyYouKind = new RegExp(`^(?:an? )?(${Arr.join(onlyYouKinds, "|")})\\b`, "iu");
const citedFile = /`(?<path>[^`]+)`/u;

const byLine = Order.mapInput(Order.Number, ({ line }: FormatProblem) => line);

const quote = (text: string) => `"${text.length > 48 ? `${Str.slice(0, 48)(text)}...` : text}"`;

const closes = (fence: Fence, text: string) => {
	const groups = fenceLine.exec(text)?.groups;

	return groups?.["info"] === "" && Str.startsWith(fence.marker)(groups["marker"] ?? "");
};

const linesOf = (file: string) => {
	const [unclosedFence, lines] = Arr.mapAccum(
		Str.split("\n")(file),
		Option.none<Fence>(),
		(open, text, index): [Option.Option<Fence>, Line] => {
			const number = index + 1;

			if (Option.isSome(open)) {
				return [closes(open.value, text) ? Option.none() : open, { number, text, fenced: true }];
			}

			const opened = Option.map(Option.fromNullishOr(fenceLine.exec(text)?.groups?.["marker"]), (marker) => ({
				line: number,
				marker,
			}));

			return [opened, { number, text, fenced: Option.isSome(opened) }];
		},
	);

	return { lines, unclosedFence };
};

const sections = (lines: ReadonlyArray<Line>) => {
	const preamble: Array<Line> = [];
	const items: Array<Item> = [];

	for (const line of lines) {
		if (!line.fenced && Str.startsWith("## ")(line.text)) {
			items.push({ title: Str.trim(Str.slice(3)(line.text)), line: line.number, body: [] });
		} else {
			(items.at(-1)?.body ?? preamble).push(line);
		}
	}

	return { preamble, items };
};

const labelProblems = (
	wanted: ReadonlyArray<string>,
	item: Item,
	prose: ReadonlyArray<Line>,
): ReadonlyArray<FormatProblem> => {
	const missing = Arr.filter(wanted, (label) => !Arr.some(prose, ({ text }) => Str.startsWith(label)(text)));

	const listedAt = (label: string) =>
		Arr.findFirst(prose, ({ text }) => Str.startsWith(label)(Str.replace(listMarker, "")(text)));

	const listed = Arr.getSomes(
		Arr.map(missing, (label) =>
			Option.map(listedAt(label), ({ number, text }) => ({
				line: number,
				message: `${quote(text)} puts ${label} in a list item or indents it. Start the line with ${label}`,
			})),
		),
	);

	const absent = Arr.filter(missing, (label) => Option.isNone(listedAt(label)));

	return [
		...listed,
		...Arr.match(absent, {
			onEmpty: () => [],
			onNonEmpty: (labels) => [
				{ line: item.line, message: `item "${item.title}" has no line that starts with ${Arr.join(labels, ", ")}` },
			],
		}),
	];
};

const itemProblems = (item: Item): ReadonlyArray<FormatProblem> => {
	const prose = Arr.filter(item.body, ({ fenced }) => !fenced);
	const headings = Arr.filter(prose, ({ text }) => Str.startsWith("#")(text));

	return [
		...Arr.map(headings, ({ number, text }) => ({
			line: number,
			message: `${quote(text)} starts with "#" inside item "${item.title}". Only "## <title>" lines start items, and inside an item only fenced code may start with "#"`,
		})),
		...labelProblems(requiredLabels, item, prose),
	];
};

export const actionItemProblems = (file: string): ReadonlyArray<FormatProblem> => {
	const { lines, unclosedFence } = linesOf(file);
	const { preamble, items } = sections(lines);
	const outside = Arr.filter(preamble, ({ text }) => !Str.startsWith("# ")(text) && itemContent.test(text));

	return Arr.sort(
		[
			...Arr.map(outside, ({ number, text }) => ({
				line: number,
				message: `${quote(text)} is outside an item. Items start only at "## <title>", and above the first one go only the "# " title and a plain note`,
			})),
			...Arr.flatMap(items, itemProblems),
			...Option.toArray(
				Option.map(unclosedFence, ({ line }) => ({ line, message: "this code fence never closes" })),
			),
		],
		byLine,
	);
};

interface OnlyYou {
	readonly problems: ReadonlyArray<FormatProblem>;
	readonly denials: ReadonlyArray<Denial>;
}

const noDenials = (line: number, message: string): OnlyYou => ({ problems: [{ line, message }], denials: [] });

const reasonOf = ({ number, text }: Line): OnlyYou => {
	const kind = onlyYouKind.exec(Str.trim(Str.slice(onlyYouLabel.length)(text)))?.[1];

	if (kind === undefined) {
		return noDenials(
			number,
			`${quote(text)} names no kind. After ${onlyYouLabel} comes one of: ${Arr.join(onlyYouKinds, ", ")}`,
		);
	}

	if (Str.toLowerCase(kind) !== "access") {
		return { problems: [], denials: [] };
	}

	const path = citedFile.exec(text)?.groups?.["path"];

	if (path === undefined) {
		return noDenials(
			number,
			`${quote(text)} is an access item that cites no file. Cite the file that records the denied attempt in backticks`,
		);
	}

	return { problems: [], denials: [{ line: number, path }] };
};

const onlyYouOf = (item: Item): OnlyYou => {
	const prose = Arr.filter(item.body, ({ fenced }) => !fenced);

	return Option.match(
		Arr.findFirst(prose, ({ text }) => Str.startsWith(onlyYouLabel)(text)),
		{
			onNone: () => ({ problems: labelProblems([onlyYouLabel], item, prose), denials: [] }),
			onSome: reasonOf,
		},
	);
};

/**
 * Each item's only-you problems: no `**Only you.**` line, a line that names no kind, an access line that cites no file
 * in backticks. And the files the access items cite, which the caller checks exist.
 * Kinds, after the label, case-insensitive, optional article: decision, approval, irreversible action, access.
 */
export const onlyYouReasons = (file: string): OnlyYou => {
	const found = Arr.map(sections(linesOf(file).lines).items, onlyYouOf);

	return {
		problems: Arr.flatMap(found, ({ problems }) => problems),
		denials: Arr.flatMap(found, ({ denials }) => denials),
	};
};
