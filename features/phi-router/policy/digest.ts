import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";

import type { Part, Transcript, Turn } from "./index.ts";

const encoder = new TextEncoder();

export const sha256 = (text: string) =>
	Effect.map(
		Effect.promise(() => crypto.subtle.digest("SHA-256", encoder.encode(text))),
		(hash) => Encoding.Hex.encode(new Uint8Array(hash)),
	);

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

const turnDigest = (turn: Turn) => sha256(encodeTurn(turn));

/**
 * The digest of all system turns together, and the chain over the conversation turns: `chains[n]` covers the first `n`,
 * with chain(0) = sha256("") and chain(n) = sha256(chain(n-1) || sha256(turn n)).
 */
export const digestsOf = Effect.fn("digestsOf")(function* (
	system: ReadonlyArray<Turn>,
	conversation: ReadonlyArray<Turn>,
) {
	const systemTurns = yield* Effect.forEach(system, turnDigest);
	const systemDigest = yield* sha256(Arr.join(systemTurns, ""));
	const turns = yield* Effect.forEach(conversation, turnDigest);
	const empty = yield* sha256("");
	const chains = Arr.of(empty);

	for (const turn of turns) {
		const next = yield* sha256(`${Arr.lastNonEmpty(chains)}${turn}`);

		chains.push(next);
	}

	return { system: systemDigest, chains };
});

/**
 * Hex SHA-256 digests of the text parts registered as fixtures. A part whose exact text has one is neither ruled on nor
 * judged. Unprovided, the registry is empty and exempts nothing.
 */
export const Fixtures = Context.Reference<ReadonlySet<string>>("pi-harness/features/phi-router/policy/Fixtures", {
	defaultValue: () => new Set(),
});

export const withoutFixtures = Effect.fn("withoutFixtures")(function* (transcript: Transcript) {
	const fixtures = yield* Fixtures;

	const isUnregistered = (part: Part) =>
		part.kind === "text" ? Effect.map(sha256(part.text), (digest) => !fixtures.has(digest)) : Effect.succeed(true);

	return yield* Effect.forEach(transcript, ({ role, parts }) =>
		Effect.map(Effect.filter(parts, isUnregistered), (kept): Turn => ({ role, parts: kept })),
	);
});
