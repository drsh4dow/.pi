import { expect, test } from "bun:test";

import * as Arr from "effect/Array";

import { ContentKey, type Piece } from "./engine.ts";
import { quotingReplies } from "./quotes.ts";

const record = 'id,patient_id,driver_license,diagnosis\n76696,76696,U2546280,B20\n  "value": "R600-434-88-750-1",';

const pieceOf = (key: string, kind: Piece["kind"], text: string) => ({
	key: ContentKey.make(key),
	kind,
	texts: [text],
});

const sealedRecord = pieceOf("record", "tool-result", record);

/** Each quoting reply's key and the key of the sealed piece it repeats, as plain strings. */
const quotingOf = (pieces: ReadonlyArray<ReturnType<typeof pieceOf>>) =>
	Arr.map(
		Arr.fromIterable(quotingReplies({ pieces, isSealed: (key) => key === sealedRecord.key })),
		([reply, source]): ReadonlyArray<string> => [reply, source],
	);

test("an ent reply that repeats a line of sealed content, or quotes part of a long one, names that content", () => {
	const quoted = [
		sealedRecord,
		pieceOf("row", "reply-other", "The failing row is\n```\n76696,76696,U2546280,B20\n```"),
		pieceOf("inline", "reply-other", 'It fails on "value": "R600-434-88-750-1", which is too long.'),
	];

	expect(quotingOf(quoted)).toEqual([
		["row", "record"],
		["inline", "record"],
	]);
});

test("a short shared line, a personal reply, a user message and a reply before the sealed content do not count", () => {
	const unquoted = [
		pieceOf("early", "reply-other", "76696,76696,U2546280,B20"),
		sealedRecord,
		pieceOf("short", "reply-other", "Row 76696:\nB20"),
		pieceOf("personal", "reply-personal", "76696,76696,U2546280,B20"),
		pieceOf("user", "user", "76696,76696,U2546280,B20"),
	];

	expect(quotingOf(unquoted)).toEqual([]);
});
