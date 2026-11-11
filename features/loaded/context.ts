import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { parseFrontmatter, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const Kind = Schema.Literals(["skill", "principle"]);

export type GuideKind = typeof Kind.Type;

/** A skill or principle file: the instructions an agent reads into its context when its trigger matches. */
export interface Guide {
	readonly kind: GuideKind;
	readonly name: string;
	readonly path: string;
	/** The body's lines no other guide shares, which mark the file wherever its text lands. */
	readonly lines: ReadonlyArray<string>;
}

/** A guide the model sees now. `by` is who put its text there: the agent through a tool, or the person through a message or `/skill:`. */
export const Loaded = Schema.Struct({
	kind: Kind,
	name: Schema.String,
	path: Schema.String,
	/** `partial` when the model sees only some of the file, such as a ranged read or cut output. */
	state: Schema.Literals(["full", "partial"]),
	by: Schema.Literals(["agent", "person"]),
});

export type Loaded = typeof Loaded.Type;

type Loader = Loaded["by"];

/** Shorter lines, such as `## Overview`, mark no file. */
const minLineLength = 20;
const fullShare = 0.9;
const partialLines = 3;

const markLines = (text: string) =>
	Arr.filter(
		Arr.map(Str.split(text, "\n"), (line) => Str.trim(line)),
		(line) => line.length >= minLineLength,
	);

/** Builds the guides from their files, keeping each body line that only one guide has. */
export const guidesOf = (
	files: ReadonlyArray<{
		readonly kind: GuideKind;
		readonly name: string;
		readonly path: string;
		readonly text: string;
	}>,
): ReadonlyArray<Guide> => {
	const bodies = Arr.map(files, (file) => Arr.dedupe(markLines(parseFrontmatter(file.text).body)));
	const owners = new Map<string, number>();

	for (const lines of bodies) {
		for (const line of lines) {
			owners.set(line, (owners.get(line) ?? 0) + 1);
		}
	}

	return Arr.map(files, ({ kind, name, path }, index) => ({
		kind,
		name,
		path,
		lines: Arr.filter(bodies[index] ?? [], (line) => owners.get(line) === 1),
	}));
};

/** A script that returns a file inside JSON shows its lines with escaped newlines and quotes. */
const unescaped = (text: string) =>
	Str.replaceAll(
		String.raw`\"`,
		'"',
	)(Str.replaceAll(String.raw`\t`, "\t")(Str.replaceAll(String.raw`\n`, "\n")(text)));

/** The text a message shows the model. The model's own replies load nothing, so assistant messages give none. */
const visibleText = (message: AgentMessage) => {
	if (message.role === "assistant" || message.role === "system") {
		return "";
	}

	if (message.role === "bashExecution") {
		return message.output;
	}

	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return message.summary;
	}

	return contentText(message.content, "\n");
};

const loaderOf = (message: AgentMessage): Loader =>
	message.role === "user" || message.role === "bashExecution" ? "person" : "agent";

export interface Index {
	readonly guides: ReadonlyArray<Guide>;
	/** Each marking line, to its guide and its place in that guide's lines. */
	readonly owner: ReadonlyMap<string, { readonly guide: number; readonly line: number }>;
	/** What each message marks, by guide. Entries never change, and a context edit hands over a new message. */
	readonly seen: WeakMap<AgentMessage, ReadonlyMap<number, ReadonlySet<number>>>;
}

export const indexOf = (guides: ReadonlyArray<Guide>): Index => ({
	guides,
	owner: new Map(
		Arr.flatMap(guides, (guide, index) => Arr.map(guide.lines, (line, at) => [line, { guide: index, line: at }])),
	),
	seen: new WeakMap(),
});

/** Which lines of which guides a message's text holds. */
const marksIn = (index: Index, text: string) => {
	const marks = new Map<number, Set<number>>();

	for (const line of [...markLines(text), ...markLines(unescaped(text))]) {
		const owner = index.owner.get(line);

		if (owner !== undefined) {
			marks.set(owner.guide, (marks.get(owner.guide) ?? new Set()).add(owner.line));
		}
	}

	return marks;
};

const marksOf = (index: Index, message: AgentMessage) => {
	const cached = index.seen.get(message);

	if (cached !== undefined) {
		return cached;
	}

	const marks = marksIn(index, visibleText(message));
	index.seen.set(message, marks);

	return marks;
};

const stateOf = (seen: number, total: number) => {
	if (seen >= total * fullShare) {
		return "full";
	}

	return seen >= Math.min(partialLines, total) ? "partial" : undefined;
};

/**
 * The guides whose text the model sees in this projection, in the order they first entered it. Branch, compaction and
 * context edits are already applied to a projection, so a guide that left the context is not in it.
 */
export const inContext = ({
	index,
	entries,
}: {
	readonly index: Index;
	readonly entries: ReadonlyArray<ProjectedSessionEntry>;
}): ReadonlyArray<Loaded> => {
	const found = new Map<number, { readonly lines: Set<number>; readonly by: Loader }>();

	for (const message of Arr.flatMap(entries, (entry) => entry.messages)) {
		for (const [guide, lines] of marksOf(index, message)) {
			const prior = found.get(guide);

			if (prior === undefined) {
				found.set(guide, { lines: new Set(lines), by: loaderOf(message) });
			} else {
				for (const line of lines) {
					prior.lines.add(line);
				}
			}
		}
	}

	return Arr.flatMap([...found], ([at, { lines, by }]) => {
		const guide = index.guides[at];
		const state = guide === undefined ? undefined : stateOf(lines.size, guide.lines.length);

		return guide === undefined || state === undefined
			? []
			: [{ kind: guide.kind, name: guide.name, path: guide.path, state, by }];
	});
};
