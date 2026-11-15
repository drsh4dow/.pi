/**
 * The strings whose presence in a request body shows that a corpus case's PHI reached it. A canary the case carries
 * whole is its own token. One it carries encoded is the encoded run around it, as pi sends it. One it splits across two
 * messages is the end of the first and the start of the second, each with some context so a short fragment cannot match
 * by chance. An image is its base64 data.
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

export interface Tokens {
	readonly tokens: ReadonlyArray<string>;
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

/** Where `head` ends a line of `text`, as the index just past it. */
const lineEnd = (text: string, head: string) => {
	if (Str.endsWith(head)(text)) {
		return Option.some(text.length);
	}

	return Option.map(Str.indexOf(`${head}\n`)(text), (at) => at + head.length);
};

/** Where `rest` starts a line of `text`. */
const lineStart = (text: string, rest: string) => {
	if (Str.startsWith(rest)(text)) {
		return Option.some(0);
	}

	return Option.map(Str.indexOf(`\n${rest}`)(text), (at) => at + 1);
};

/** The ways to cut a canary in two: as written, and without the whitespace at the cut, since compaction trims a summary. */
const cutsOf = (canary: string) =>
	Arr.flatMap(Arr.range(1, canary.length - 1), (cut) => {
		const head = Str.slice(0, cut)(canary);
		const rest = Str.slice(cut)(canary);
		const trimmed = { head: Str.trimEnd(head), rest: Str.trimStart(rest) };

		return Str.isEmpty(trimmed.head) || Str.isEmpty(trimmed.rest) ? [{ head, rest }] : [{ head, rest }, trimmed];
	});

/** The two messages a canary is split across: its head ends a line of one, and its rest starts a line of a later one. */
const split = (canary: string, texts: ReadonlyArray<string>) =>
	Arr.findFirst(cutsOf(canary), ({ head, rest }) => {
		const first = Arr.findFirst(texts, (text, at) =>
			Option.map(lineEnd(text, head), (end) => ({
				at,
				token: Str.slice(Math.max(0, end - head.length - context), end)(text),
			})),
		);

		return Option.flatMap(first, ({ at, token }) => {
			const second = Arr.findFirst(Arr.drop(texts, at + 1), (text) =>
				Option.map(lineStart(text, rest), (start) => Str.slice(start, start + rest.length + context)(text)),
			);

			return Option.map(second, (next) => [token, next]);
		});
	});

const tokensOfCanary = (canary: string, texts: ReadonlyArray<string>) =>
	Effect.map(encoded(canary, texts), (found) =>
		Option.firstSomeOf([whole(canary, texts), found, split(canary, texts)]),
	);

/** The texts pi sends for the case's messages, with a compaction summary as the mock writes it back. */
const sentTexts = ({ messages }: Case) =>
	Arr.flatMap(messages, (message) =>
		"text" in message ? [Option.getOrElse(summaryOf(message.text), () => message.text)] : [],
	);

export const tokensOf = Effect.fn("tokensOf")(function* (subject: Case) {
	const texts = sentTexts(subject);
	const images = Arr.flatMap(subject.messages, (message) => ("image" in message ? [message.image.data] : []));

	const found = yield* Effect.forEach(subject.canaries, (canary) =>
		Effect.map(tokensOfCanary(canary, texts), (tokens) => ({ canary, tokens })),
	);

	return {
		tokens: [...Arr.flatMap(found, ({ tokens }) => Option.getOrElse(tokens, () => [])), ...images],
		untracked: Arr.map(
			Arr.filter(found, ({ tokens }) => Option.isNone(tokens)),
			({ canary }) => canary,
		),
	} satisfies Tokens;
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
