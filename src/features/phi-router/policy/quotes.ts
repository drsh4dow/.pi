/**
 * An `ent` reply is written from the sealed content before it, so it can repeat an identifier without the label that
 * made it one, such as a record's row without its header. The judge reads it alone and clears it. A reply that repeats a
 * line of sealed content therefore seals without a judge call.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { ContentKey, Piece } from "./engine.ts";
import { quoteMinChars } from "./policy.ts";

const linesOf = (texts: ReadonlyArray<string>) => {
	const lines = Arr.map(Arr.flatMap(texts, Str.split("\n")), Str.trim);

	return Arr.filter(lines, (line) => line.length >= quoteMinChars);
};

/** Either holds a whole line of the other, so a quoted part of a long line counts as well as a quoted line. */
const repeats = (reply: ReadonlyArray<string>, sealed: ReadonlyArray<string>) => {
	const replyText = Arr.join(reply, "\n");
	const sealedText = Arr.join(sealed, "\n");

	return (
		Arr.some(linesOf(reply), (line) => Str.includes(line)(sealedText)) ||
		Arr.some(linesOf(sealed), (line) => Str.includes(line)(replyText))
	);
};

/** Each \`reply-other\` piece that repeats a line of a sealed piece before it, with the first such sealed piece. */
export const quotingReplies = ({
	pieces,
	isSealed,
}: {
	readonly pieces: ReadonlyArray<Pick<Piece, "key" | "kind" | "texts">>;
	readonly isSealed: (key: ContentKey) => boolean;
}): ReadonlyMap<ContentKey, ContentKey> => {
	const sealed: Array<Pick<Piece, "key" | "texts">> = [];
	const quoting = new Map<ContentKey, ContentKey>();

	for (const { key, kind, texts } of pieces) {
		const source =
			kind === "reply-other" ? Arr.findFirst(sealed, (each) => repeats(texts, each.texts)) : Option.none();

		if (Option.isSome(source)) {
			quoting.set(key, source.value.key);
		}

		if (isSealed(key)) {
			sealed.push({ key, texts });
		}
	}

	return quoting;
};
