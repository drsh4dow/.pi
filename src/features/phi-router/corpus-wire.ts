/**
 * How the corpus wire scenario plays one manifest case through a real pi, and which strings in a request body show
 * that the case's PHI reached it. Pure, so the plan and the tokens are tested without pi.
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Encoding from "effect/encoding";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Str from "effect/String";

import { narrativeCap } from "#src/features/compaction/index.ts";
import { Reply } from "./anthropic.fixture.ts";
import type { Case, Message } from "./corpus/manifest.ts";

/** A file the case's pi reads, at `path` under its project folder. */
export interface Planted {
	readonly path: string;
	readonly bytes: Uint8Array;
}

/** An image as pi's RPC takes it with a prompt. */
export interface Image {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

/** A prompt or steering message as the driver sends it: its text, or its text and images. */
export type Sent = string | { readonly text: string; readonly images: ReadonlyArray<Image> };

export type Step = Data.TaggedEnum<{
	/** A prompt; with `steer`, a steering message sent while the prompt's first tool call runs. */
	Turn: { readonly prompt: Sent; readonly steer: Option.Option<Sent> };
	/** Pi's manual compaction, which the mock answers with `summary`. */
	Compact: { readonly summary: string };
}>;

export const Step = Data.taggedEnum<Step>();

export interface Plan {
	/** The case's system messages, which pi reads from the project's `AGENTS.md`. */
	readonly agents: Option.Option<string>;
	readonly files: ReadonlyArray<Planted>;
	/** What the mock answers each request with, in order, before it answers `done`. */
	readonly replies: ReadonlyArray<Reply>;
	readonly steps: Array<Step>;
}

/** A word in every filler prompt, so the mock answers it without spending a scripted reply. */
export const fillerMark = "FILLER-TURN";

const fillerLines = Arr.join(Arr.replicate("The build uses bun and the tests live next to the code.", 250), "\n");

const filler = (turn: number) =>
	Step.Turn({
		prompt: `${fillerMark} ${String(turn)}. Inert filler before a compaction. Reply only ok.\n${fillerLines}`,
		steer: Option.none(),
	});

const summaryPattern =
	/^The conversation history before this point was compacted into the following summary:\s*<summary>(?<inner>[\s\S]*?)<\/summary>\s*$/u;

/**
 * The text inside a compaction summary message as compaction keeps it, trimmed: what the mock answers the compaction
 * request with. None when the message is no summary, or when its text is longer than compaction keeps, since
 * compaction would replace it and only a pasted turn can carry it.
 */
export const summaryOf = (text: string) => {
	const inner = Option.fromNullishOr(summaryPattern.exec(text)?.groups?.["inner"]);

	return Option.filter(Option.map(inner, Str.trim), (summary) => summary.length <= narrativeCap);
};

const extensions = new Map([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
]);

type TextMessage = Extract<Message, { readonly text: string }>;

type ImageMessage = Extract<Message, { readonly image: unknown }>;

const isText = (message: Message): message is TextMessage => "text" in message;

const imageOf = ({ image }: ImageMessage): Image => ({ type: "image", ...image });

const pathOf = (message: Message, index: number) =>
	`files/${String(index)}.${isText(message) ? "txt" : (extensions.get(message.image.mimeType) ?? "png")}`;

const bytesOf = (message: Message) =>
	isText(message)
		? new TextEncoder().encode(message.text)
		: Result.getOrElse(Encoding.Base64.decode(message.image.data), () => new Uint8Array());

/** Each of the case's turns with the message before and after it. */
const walk = (turns: ReadonlyArray<Message>) =>
	Arr.map(turns, (message, index) => ({
		message,
		index,
		before: Arr.get(turns, index - 1),
		after: Arr.get(turns, index + 1),
	}));

type At = ReturnType<typeof walk>[number];

const isSteering = (subject: Case) => subject.expect === "phi" && subject.strata.entry === "steering";

interface Page {
	readonly first: number;
	readonly last: number;
	readonly bytes: number;
}

const pageBytes = 40_000;

/** Line ranges, 1-based and inclusive, of at most `pageBytes` each, so pi's 50 KB tool output limit cuts none of them. */
const pagesOf = (text: string) =>
	Arr.reduce(Str.split("\n")(text), Arr.empty<Page>(), (pages, line, index) => {
		const bytes = new TextEncoder().encode(line).length + 1;
		const last = Option.filter(Arr.last(pages), (page) => page.bytes + bytes <= pageBytes);

		if (Option.isNone(last)) {
			return [...pages, { first: index + 1, last: index + 1, bytes }];
		}

		return [...Arr.dropRight(pages, 1), { ...last.value, last: index + 1, bytes: last.value.bytes + bytes }];
	});

const isCat = (subject: Case) => subject.expect === "phi" && subject.strata.entry === "tool-result";

/** A text over one page is read a page at a time, as an agent pages through a long file or output. */
const pagedCalls = (subject: Case, path: string, text: string) => {
	const pages = pagesOf(text);

	if (pages.length === 1) {
		return [isCat(subject) ? { name: "bash", input: { command: `cat ${path}` } } : { name: "read", input: { path } }];
	}

	return Arr.map(pages, ({ first, last }) =>
		isCat(subject)
			? { name: "bash", input: { command: `sed -n '${String(first)},${String(last)}p' ${path}` } }
			: { name: "read", input: { path, offset: first, limit: last - first + 1 } },
	);
};

/** A steering case's tool call runs for a few seconds, so the steering message arrives while it runs. */
const awaitsSteering = (subject: Case, after: Option.Option<Message>) =>
	isSteering(subject) && Option.exists(after, (next) => next.role === "user" && isText(next));

const toolCalls = (subject: Case, { message, index, after }: At) => {
	const path = pathOf(message, index);

	if (!isText(message)) {
		return [{ name: "read", input: { path } }];
	}

	if (awaitsSteering(subject, after)) {
		return [{ name: "bash", input: { command: `sleep 3; cat ${path}` } }];
	}

	return pagedCalls(subject, path, message.text);
};

const pageTextsOf = (text: string) => {
	const lines = Str.split("\n")(text);

	return Arr.map(pagesOf(text), ({ first, last }) => Arr.join(Arr.drop(Arr.take(lines, last), first - 1), "\n"));
};

/** Each text the case's pi sends as one message: the summary compaction keeps, each page of a paged tool output, or the text. */
export const sentTextsOf = (subject: Case) =>
	Arr.flatMap(walk(subject.messages), ({ message, after }) => {
		if (!isText(message)) {
			return [];
		}

		if (message.role === "tool" && !awaitsSteering(subject, after)) {
			return pageTextsOf(message.text);
		}

		return [Option.getOrElse(summaryOf(message.text), () => message.text)];
	});

const assistantText = (at: Option.Option<Message>) =>
	Option.flatMap(
		Option.filter(at, (message) => message.role === "assistant"),
		(message) => (isText(message) ? Option.some(message.text) : Option.none()),
	);

/** A tool message is a tool call the mock asks for, with the assistant text before it; other assistant text is a reply. */
const replyOf =
	(subject: Case) =>
	(at: At): ReadonlyArray<Reply> => {
		if (at.message.role === "tool") {
			return Arr.map(toolCalls(subject, at), (call, page) =>
				Reply.ToolUse({ before: page === 0 ? assistantText(at.before) : Option.none(), ...call }),
			);
		}

		const ends = at.message.role === "assistant" && !Option.exists(at.after, (next) => next.role === "tool");

		return ends && isText(at.message) ? [Reply.Text({ text: at.message.text })] : [];
	};

const opened = (prompt: Sent) => Step.Turn({ prompt, steer: Option.none() });

const withImage = (sent: Sent, image: Image): Sent =>
	Predicate.isString(sent) ? { text: sent, images: [image] } : { text: sent.text, images: [...sent.images, image] };

const attached = (steps: Array<Step>, image: Image): Array<Step> => {
	const last = Option.filter(Arr.last(steps), Step.$is("Turn"));

	if (Option.isNone(last)) {
		return [...steps, opened(withImage("See the attached image.", image))];
	}

	const { prompt, steer } = last.value;

	const turn = Option.isSome(steer)
		? Step.Turn({ prompt, steer: Option.some(withImage(steer.value, image)) })
		: Step.Turn({ prompt: withImage(prompt, image), steer });

	return [...Arr.dropRight(steps, 1), turn];
};

/** The steps with `text` as the steering message of the last turn, when that turn has none yet. */
const steered = (steps: Array<Step>, text: string): Option.Option<Array<Step>> => {
	const last = Option.filter(Arr.last(steps), Step.$is("Turn"));

	if (Option.isNone(last) || Option.isSome(last.value.steer)) {
		return Option.none();
	}

	return Option.some([...Arr.dropRight(steps, 1), Step.Turn({ prompt: last.value.prompt, steer: Option.some(text) })]);
};

/** A summary becomes two filler turns, a compaction, and a turn that carries the summary to the next request. */
const userText = (subject: Case, steps: Array<Step>, at: At & { readonly message: TextMessage }) => {
	const { text } = at.message;
	const summary = summaryOf(text);

	if (Option.isSome(summary)) {
		const compact = Step.Compact({ summary: summary.value });

		return [...steps, filler(1), filler(2), compact, opened("Continue from the summary.")];
	}

	const afterTool = Option.exists(at.before, (message) => message.role === "tool");
	const steering = isSteering(subject) && afterTool ? steered(steps, text) : Option.none();

	return Option.getOrElse(steering, () => [...steps, opened(text)]);
};

const stepsOf =
	(subject: Case) =>
	(steps: Array<Step>, at: At): Array<Step> => {
		const { message } = at;

		if (message.role !== "user") {
			return steps;
		}

		return isText(message) ? userText(subject, steps, { ...at, message }) : attached(steps, imageOf(message));
	};

const textsOf = (messages: ReadonlyArray<Message>) => Arr.map(Arr.filter(messages, isText), ({ text }) => text);

/** Only a prompt makes pi ask the mock, so a case whose first message is a tool result or a reply opens with this. */
const neutralOpening = opened("Go on with the task.");

/**
 * A reply that opens a case was written before the case began, on `ent` for an `ent-reply` case. A personal account's
 * reply skips the judge, so the mock plays it on `ent`, as the answer to the neutral opening in a pinned session.
 */
const pinnedReply = [opened("/phi pin"), neutralOpening, opened("/phi unpin")];

export const planOf = (subject: Case): Plan => {
	const turns = Arr.filter(subject.messages, (message) => message.role !== "system");
	const leadingReply = Arr.filter(Arr.take(turns, 1), (message) => message.role === "assistant" && isText(message));
	const walked = walk(Arr.drop(turns, leadingReply.length));
	const tools = Arr.filter(walked, ({ message }) => message.role === "tool");
	const systems = textsOf(Arr.filter(subject.messages, (message) => message.role === "system"));
	const awaitsPrompt = Option.exists(Arr.head(walked), ({ message }) => message.role !== "user");

	const opening = [...(leadingReply.length > 0 ? pinnedReply : []), ...(awaitsPrompt ? [neutralOpening] : [])];

	return {
		agents: Option.liftPredicate(Arr.join(systems, "\n\n"), Str.isNonEmpty),
		files: Arr.map(tools, ({ message, index }) => ({ path: pathOf(message, index), bytes: bytesOf(message) })),
		replies: [
			...Arr.map(textsOf(leadingReply), (text) => Reply.Text({ text })),
			...Arr.flatMap(walked, replyOf(subject)),
		],
		steps: Arr.reduce(walked, opening, stepsOf(subject)),
	};
};
