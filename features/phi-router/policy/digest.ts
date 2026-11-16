import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import { hash } from "fast-sha256";

import type { Part, Transcript, Turn } from "./index.ts";

const encoder = new TextEncoder();

/**
 * Hex SHA-256 of `text` as UTF-8. Synchronous, because the lane border keys messages inside a provider's stream call,
 * where WebCrypto's promise does not fit.
 */
export const sha256 = (text: string) => Encoding.Hex.encode(hash(encoder.encode(text)));

const field = (value: string) => `${String(value.length)}:${value}`;

/** UTF-8 turns a lone surrogate into U+FFFD, the one difference the digest cannot see. */
const encodeTurn = ({ role, parts }: Turn) =>
	Arr.join(
		[
			field(role),
			...Arr.map(parts, (part) =>
				part.kind === "text" ? `t${field(part.text)}` : `i${field(part.mimeType)}${field(part.data)}`,
			),
		],
		"",
	);

/**
 * The digest of all system turns together, and the chain over the conversation turns: `chains[n]` covers the first `n`,
 * with chain(0) = sha256("") and chain(n) = sha256(chain(n-1) || sha256(turn n)).
 */
export const digestsOf = ({
	system,
	conversation,
}: {
	readonly system: ReadonlyArray<Turn>;
	readonly conversation: ReadonlyArray<Turn>;
}) => {
	const systemTurns = Arr.map(system, (turn) => sha256(encodeTurn(turn)));
	const systemDigest = sha256(Arr.join(systemTurns, ""));
	const chains = Arr.of(sha256(""));

	for (const turn of conversation) {
		const turnDigest = sha256(encodeTurn(turn));

		chains.push(sha256(`${Arr.lastNonEmpty(chains)}${turnDigest}`));
	}

	return { system: systemDigest, chains };
};

/**
 * Hex SHA-256 digests of the text parts registered as fixtures. A part whose exact text has one is neither ruled on nor
 * judged. Unprovided, the registry is empty and exempts nothing.
 */
export const Fixtures = Context.Reference<ReadonlySet<string>>("pi-harness/features/phi-router/policy/Fixtures", {
	defaultValue: () => new Set(),
});

export const withoutFixtures = Effect.fn("withoutFixtures")(function* (transcript: Transcript) {
	const fixtures = yield* Fixtures;

	const isUnregistered = (part: Part) => part.kind !== "text" || !fixtures.has(sha256(part.text));

	return Arr.map(transcript, ({ role, parts }): Turn => ({ role, parts: Arr.filter(parts, isUnregistered) }));
});
