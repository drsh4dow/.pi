import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { Case } from "./manifest.ts";
import { sentTextsOf } from "./wire.ts";

interface Split {
	readonly canary: string;
	readonly parts: ReadonlyArray<string>;
}

export interface Tracked {
	/** Tokens that show a canary whole. */
	readonly complete: ReadonlyArray<string>;
	readonly splits: ReadonlyArray<Split>;
	readonly fragments: ReadonlyArray<string>;
	/** One distinctive piece of each message that holds a complete canary. */
	readonly sealed: ReadonlyArray<string>;
	/** Canaries no message carries in a form this module finds, so the run cannot vouch for them. */
	readonly untracked: ReadonlyArray<string>;
}

const context = 40;

const base64Run = /[A-Za-z0-9+/]{24,}={0,2}/gu;

const hexRun = /(?:[0-9a-fA-F]{2}){12,}/gu;

const textDecoder = new TextDecoder();

const isGzip = (bytes: Uint8Array) => bytes[0] === 31 && bytes[1] === 139;

const inflated = (bytes: Uint8Array) =>
	new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"))).text();

/** None when the bytes are not a whole gzip stream. */
const gunzipped = (bytes: Uint8Array) =>
	Effect.option(Effect.tryPromise({ try: () => inflated(bytes), catch: () => "not gzip" as const }));

const textOfBytes = (bytes: Uint8Array) =>
	isGzip(bytes) ? gunzipped(bytes) : Effect.succeedSome(textDecoder.decode(bytes));

const runsOf = (text: string) => [
	...Arr.map(Arr.fromIterable(Str.matchAll(base64Run)(text)), ([run]) => ({
		run,
		bytes: Encoding.Base64.decode(run),
	})),
	...Arr.map(Arr.fromIterable(Str.matchAll(hexRun)(text)), ([run]) => ({ run, bytes: Encoding.Hex.decode(run) })),
];

const whole = (canary: string, texts: ReadonlyArray<string>) =>
	Option.liftPredicate([canary], () => Arr.some(texts, Str.includes(canary)));

/** The first base64 or hex run whose bytes, gunzipped when they are gzip, hold the canary. */
const encoded = (canary: string, texts: ReadonlyArray<string>) =>
	Effect.map(
		Effect.findFirst(Arr.flatMap(texts, runsOf), ({ bytes }) =>
			Result.isSuccess(bytes)
				? Effect.map(textOfBytes(bytes.success), Option.exists(Str.includes(canary)))
				: Effect.succeed(false),
		),
		Option.map(({ run }) => [run]),
	);

const partToken = (part: string, texts: ReadonlyArray<string>) =>
	Arr.findFirst(texts, (text) =>
		Option.map(Str.indexOf(part)(text), (at) =>
			Str.slice(Math.max(0, at - context), at + part.length + context)(text),
		),
	);

const splitOf = (subject: Case, canary: string, texts: ReadonlyArray<string>): Option.Option<Split> => {
	const declared = subject.expect === "phi" ? Option.fromUndefinedOr(subject.canaryParts?.[canary]) : Option.none();

	return Option.flatMap(declared, (parts) => {
		const tokens = Arr.getSomes(Arr.map(parts, (part) => partToken(part, texts)));

		return Option.liftPredicate({ canary, parts: tokens }, () => tokens.length === parts.length);
	});
};

const sealedWidth = 40;

const windowsOf = (text: string) =>
	Arr.map(Arr.range(0, Math.max(-1, text.length - sealedWidth)), (start) => ({
		start,
		window: Str.slice(start, start + sealedWidth)(text),
	}));

type Window = ReturnType<typeof windowsOf>[number];

const isOneLine = ({ window }: Window) => !Str.includes("\n")(window);

/**
 * A 40-character window of `text` that no message without a complete canary holds. A window clear of every canary is
 * preferred, so a message sent with its identifier redacted is still caught, and then one on a single line. A message
 * that is all canary, such as one encoded run, falls back to a window inside it. The search stops at the first match,
 * since a page of a long output is checked against every other page.
 */
const distinctive = (text: string, canaries: ReadonlyArray<string>, others: ReadonlyArray<string>) => {
	const taken = Arr.flatMap(canaries, (canary) =>
		Arr.map(
			Arr.filter(Arr.range(0, text.length - canary.length), (at) => Str.startsWith(canary, at)(text)),
			(at) => ({ from: at, to: at + canary.length }),
		),
	);

	const windows = windowsOf(text);
	const isClear = ({ start }: Window) => !Arr.some(taken, ({ from, to }) => start < to && from < start + sealedWidth);

	const first = (keep: (window: Window) => boolean) =>
		Arr.findFirst(windows, (each) => keep(each) && !Arr.some(others, Str.includes(each.window)));

	const found = Option.orElse(
		first((each) => isClear(each) && isOneLine(each)),
		() => Option.orElse(first(isClear), () => first(() => true)),
	);

	return Option.map(found, ({ window }) => window);
};

export const tokensOf = Effect.fn("tokensOf")(function* (subject: Case) {
	const texts = sentTextsOf(subject);
	const images = Arr.flatMap(subject.messages, (message) => ("image" in message ? [message.image.data] : []));
	const sent = [...texts, ...images];

	const found = yield* Effect.forEach(subject.canaries, (canary) =>
		Effect.map(encoded(canary, texts), (run) => ({
			canary,
			complete: Option.orElse(whole(canary, sent), () => run),
			split: splitOf(subject, canary, texts),
		})),
	);

	const complete = Arr.flatMap(found, ({ complete: tokens }) => Option.getOrElse(tokens, () => []));
	const holds = (text: string) => Arr.some(complete, (token) => Str.includes(token)(text));
	const holding: ReadonlyArray<string> = Arr.filter(sent, holds);
	const others = Arr.filter(sent, (text) => !holds(text));

	return {
		complete,
		splits: Arr.flatMap(found, ({ split: cut }) => Option.toArray(cut)),
		fragments: subject.fragments,
		sealed: Arr.flatMap(holding, (text) => Option.toArray(distinctive(text, complete, others))),
		untracked: Arr.map(
			Arr.filter(found, ({ complete: tokens, split: cut }) => Option.isNone(tokens) && Option.isNone(cut)),
			({ canary }) => canary,
		),
	} satisfies Tracked;
});

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const isJsonArray = (json: Schema.Json): json is Schema.JsonArray => Arr.isArray(json);

const stringsOf = (json: Schema.Json): ReadonlyArray<string> => {
	if (Predicate.isString(json)) {
		return [json];
	}

	if (isJsonArray(json)) {
		return Arr.flatMap(json, stringsOf);
	}

	return Predicate.isObjectKeyword(json) ? Arr.flatMap(Rec.values(json), stringsOf) : [];
};

/** A body as sent, and each string in it once decoded, so a token with a quote or a line break still matches. */
const textsOf = (body: string) => [body, ...Arr.flatMap(Option.toArray(decodeJson(body)), stringsOf)];

export const foundIn = (input: { readonly bodies: ReadonlyArray<string>; readonly tokens: ReadonlyArray<string> }) => {
	const texts = Arr.flatMap(input.bodies, textsOf);

	return Arr.filter(input.tokens, (token) => Arr.some(texts, Str.includes(token)));
};

const isJsonObject = (json: Schema.Json): json is Schema.JsonObject =>
	Predicate.isObjectKeyword(json) && !isJsonArray(json);

const isToolResult = (block: Schema.Json) => isJsonObject(block) && block["type"] === "tool_result";

/** Pi sends each tool result as its own message, and the Anthropic body groups consecutive ones in one turn. */
const turnMessages = (turn: Schema.Json): ReadonlyArray<Schema.Json> => {
	const content = isJsonObject(turn) ? turn["content"] : undefined;

	if (content === undefined || !isJsonArray(content) || !Arr.some(content, isToolResult)) {
		return [turn];
	}

	return [...Arr.filter(content, isToolResult), Arr.filter(content, (block) => !isToolResult(block))];
};

const messagesOfJson = (json: Schema.Json): ReadonlyArray<ReadonlyArray<string>> => {
	if (isJsonArray(json)) {
		return Arr.map(json, stringsOf);
	}

	if (!isJsonObject(json)) {
		return [stringsOf(json)];
	}

	const { messages: turns = [], ...rest } = json;
	const messages = isJsonArray(turns) ? Arr.flatMap(turns, turnMessages) : [turns];

	return [...Arr.map(messages, stringsOf), stringsOf(rest)];
};

/**
 * The strings of each message in a request body: each tool result and each other turn of an Anthropic body, with the
 * rest of the body (system prompt, tools) as one more, or each element of the engine eval's message array. A body that
 * is no JSON is one message.
 */
const messagesOf = (body: string) => Option.match(decodeJson(body), { onNone: () => [[body]], onSome: messagesOfJson });

const holds = (message: ReadonlyArray<string>) => (token: string) => Arr.some(message, Str.includes(token));

/**
 * How a split canary reached personal accounts, judged by the message that carried each part. The human ruled: "an
 * identifier split across a message boundary is an accepted risk; reported, not gated". So a canary is `split`, the
 * accepted risk, only when every part reached a personal account and no one message held them all or held the canary
 * whole. A message that holds the canary whole, or holds every part, makes it `whole`, a leak that fails the gate
 * whatever the case's label. Some parts alone are `partial`: fragments, never a leak.
 */
type SplitReach = "whole" | "split" | "partial" | "none";

const splitReachOf = ({
	split,
	received,
}: {
	readonly split: Split;
	/** The strings of each message personal accounts received. */
	readonly received: ReadonlyArray<ReadonlyArray<string>>;
}): SplitReach => {
	const holdsWhole = (message: ReadonlyArray<string>) =>
		holds(message)(split.canary) || Arr.every(split.parts, holds(message));

	if (Arr.some(received, holdsWhole)) {
		return "whole";
	}

	const reached = Arr.filter(split.parts, (part) => Arr.some(received, (message) => holds(message)(part)));

	if (reached.length === split.parts.length) {
		return "split";
	}

	return reached.length > 0 ? "partial" : "none";
};

export interface Seen {
	/** Complete canary tokens in a personal body, and split canaries one personal message held whole. */
	readonly leaked: ReadonlyArray<string>;
	/** Split canaries whose parts reached personal accounts only in different messages. Reported, never a leak. */
	readonly split: ReadonlyArray<string>;
	/** Distinctive pieces of canary-holding messages in a personal body. */
	readonly unsealed: ReadonlyArray<string>;
	/** Fragments, and parts of a split canary that did not all arrive, in a personal body. Reported, never a leak. */
	readonly fragments: ReadonlyArray<string>;
	/** Tokens no `ent` body carried, but for split parts a personal body carried, being fragments; untracked canaries. */
	readonly missing: ReadonlyArray<string>;
}

interface Bodies {
	readonly tracked: Tracked;
	readonly personal: ReadonlyArray<string>;
	readonly ent: ReadonlyArray<string>;
}

export const seenOn = ({ tracked, personal, ent }: Bodies): Seen => {
	const inPersonal = (tokens: ReadonlyArray<string>) => foundIn({ bodies: personal, tokens });
	const received = Arr.flatMap(personal, messagesOf);
	const reaches = Arr.map(tracked.splits, (split) => ({ split, reach: splitReachOf({ split, received }) }));
	const reaching = (reach: SplitReach) => Arr.filter(reaches, (each) => each.reach === reach);
	const canaries = (reach: SplitReach) => Arr.map(reaching(reach), ({ split }) => split.canary);

	const parts = Arr.flatMap(tracked.splits, (split) => split.parts);
	const delivered = [...tracked.complete, ...parts, ...tracked.sealed];
	const reached = [...foundIn({ bodies: ent, tokens: delivered }), ...inPersonal(parts)];

	return {
		leaked: Arr.dedupe([...inPersonal(tracked.complete), ...canaries("whole")]),
		split: canaries("split"),
		unsealed: inPersonal(tracked.sealed),
		fragments: inPersonal([...tracked.fragments, ...Arr.flatMap(reaching("partial"), ({ split }) => split.parts)]),
		missing: [...Arr.difference(delivered, reached), ...tracked.untracked],
	};
};
