/**
 * What the corpus wire run looks for in request bodies to tell where a case's planted identifiers went. A complete
 * canary is itself, or the base64 or hex run that carries it. A split canary is its parts, each with the text around it
 * so a short part cannot match by chance. A fragment is itself. An image canary is a run of the image's base64 data.
 * Each message that holds a complete canary also yields a distinctive 40-character piece clear of the canary, which no
 * personal account may receive, so a router that redacts the identifier but sends the sealed message still fails.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { summaryOf } from "./corpus-wire.ts";
import type { Case } from "./corpus/manifest.ts";

/** A split canary and the tokens of its parts, in order. */
export interface Split {
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

/** A part with up to `context` characters around it, from the first text that holds it. */
const partToken = (part: string, texts: ReadonlyArray<string>) =>
	Arr.findFirst(texts, (text) =>
		Option.map(Str.indexOf(part)(text), (at) =>
			Str.slice(Math.max(0, at - context), at + part.length + context)(text),
		),
	);

/** The part tokens of a canary the case declares split, when every part is found. */
const splitOf = (subject: Case, canary: string, texts: ReadonlyArray<string>): Option.Option<Split> => {
	const declared = subject.expect === "phi" ? Option.fromUndefinedOr(subject.canaryParts?.[canary]) : Option.none();

	return Option.flatMap(declared, (parts) => {
		const tokens = Arr.getSomes(Arr.map(parts, (part) => partToken(part, texts)));

		return Option.liftPredicate({ canary, parts: tokens }, () => tokens.length === parts.length);
	});
};

/** The texts pi sends for the case's messages, with a compaction summary as the mock writes it back. */
const sentTexts = ({ messages }: Case) =>
	Arr.flatMap(messages, (message) =>
		"text" in message ? [Option.getOrElse(summaryOf(message.text), () => message.text)] : [],
	);

const sealedWidth = 40;

const windowsOf = (text: string) =>
	Arr.map(Arr.range(0, Math.max(-1, text.length - sealedWidth)), (start) => ({
		start,
		window: Str.slice(start, start + sealedWidth)(text),
	}));

/**
 * A 40-character window of `text` that no message without a complete canary holds. A window clear of every canary is
 * preferred, so a message sent with its identifier redacted is still caught, and then one on a single line, since pi
 * pages a long tool output at line breaks. A message that is all canary, such as one encoded run, falls back to a
 * window inside it.
 */
const distinctive = (text: string, canaries: ReadonlyArray<string>, others: ReadonlyArray<string>) => {
	const taken = Arr.flatMap(canaries, (canary) =>
		Arr.map(
			Arr.filter(Arr.range(0, text.length - canary.length), (at) => Str.startsWith(canary, at)(text)),
			(at) => ({ from: at, to: at + canary.length }),
		),
	);

	const unique = Arr.filter(windowsOf(text), ({ window }) => !Arr.some(others, Str.includes(window)));

	const clear = Arr.filter(
		unique,
		({ start }) => !Arr.some(taken, ({ from, to }) => start < to && from < start + sealedWidth),
	);

	const oneLine = Arr.findFirst(clear, ({ window }) => !Str.includes("\n")(window));

	return Option.map(Option.firstSomeOf([oneLine, Arr.head(clear), Arr.head(unique)]), ({ window }) => window);
};

export const tokensOf = Effect.fn("tokensOf")(function* (subject: Case) {
	const texts = sentTexts(subject);
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

/** Where a case's identifiers went, from the bodies each lane received over the whole run. */
export interface Seen {
	/** Complete canary tokens in a personal body, and split canaries whose every part reached one. */
	readonly leaked: ReadonlyArray<string>;
	/** Distinctive pieces of canary-holding messages in a personal body. */
	readonly unsealed: ReadonlyArray<string>;
	/** Fragments, and parts of a split canary that did not complete, in a personal body. Reported, never a leak. */
	readonly fragments: ReadonlyArray<string>;
	/** Tokens no `ent` body carried, and untracked canaries. */
	readonly missing: ReadonlyArray<string>;
}

interface Bodies {
	readonly tracked: Tracked;
	/** Every body the personal mocks received over the run, and every body the `ent` mock received. */
	readonly personal: ReadonlyArray<string>;
	readonly ent: ReadonlyArray<string>;
}

export const seenOn = ({ tracked, personal, ent }: Bodies): Seen => {
	const inPersonal = (tokens: ReadonlyArray<string>) => foundIn({ bodies: personal, tokens });

	const rejoined = ({ canary, parts }: Split) =>
		inPersonal([canary]).length > 0 || inPersonal(parts).length === parts.length;

	const rejoinedSplits = Arr.filter(tracked.splits, rejoined);
	const partialSplits = Arr.filter(tracked.splits, (split) => !rejoined(split));

	const delivered = [...tracked.complete, ...Arr.flatMap(tracked.splits, ({ parts }) => parts), ...tracked.sealed];

	return {
		leaked: [...inPersonal(tracked.complete), ...Arr.map(rejoinedSplits, ({ canary }) => canary)],
		unsealed: inPersonal(tracked.sealed),
		fragments: inPersonal([...tracked.fragments, ...Arr.flatMap(partialSplits, ({ parts }) => parts)]),
		missing: [...Arr.difference(delivered, foundIn({ bodies: ent, tokens: delivered })), ...tracked.untracked],
	};
};
