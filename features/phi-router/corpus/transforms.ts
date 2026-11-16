import * as Arr from "effect/Array";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { compactJson, gzip, prettyJson } from "./encodings.ts";
import type { Random } from "./random.ts";
import { uuid } from "./record.ts";

const misspell = (rng: Random, word: string) => {
	const at = rng.between(1, word.length - 3);

	const [head, here, next, tail] = [
		Str.slice(0, at)(word),
		word[at] ?? "",
		word[at + 1] ?? "",
		Str.slice(at + 2)(word),
	];

	return rng.pick([`${head}${next}${here}${tail}`, `${head}${next}${tail}`, `${head}${here}${here}${next}${tail}`]);
};

const isKeyword = (word: string) => /^\p{Lu}+$/u.test(word);

const misspellWords = (rng: Random, text: string) =>
	Arr.join(
		Arr.map(Str.split(/(?<word>\p{L}{5,})/u)(text), (piece, index) =>
			index % 2 === 1 && !isKeyword(piece) && rng.chance(0.3) ? misspell(rng, piece) : piece,
		),
		"",
	);

/** Misspells labels and words of five letters or more, and never a canary. */
export const withTypos =
	({ rng, canaries }: { readonly rng: Random; readonly canaries: ReadonlyArray<string> }) =>
	(text: string) => {
		const pieces = Arr.reduce(canaries, [text], (split, canary) =>
			Arr.flatMap(split, (piece) => Arr.intersperse(Str.split(canary)(piece), canary)),
		);

		const typed = Arr.map(pieces, (piece) => (Arr.contains(canaries, piece) ? piece : misspellWords(rng, piece)));

		return Arr.join(typed, "");
	};

export const asBase64 =
	({ rng, mimeType }: { readonly rng: Random; readonly mimeType: string }) =>
	(payload: string) => {
		const data = Base64.encode(payload);

		const envelopes = [
			() => prettyJson({ resourceType: "Binary", id: uuid(rng), contentType: mimeType, data }),
			() =>
				prettyJson({
					Messages: [{ MessageId: uuid(rng), ReceiptHandle: rng.hex(24), MD5OfBody: rng.hex(32), Body: data }],
				}),
			() =>
				Arr.join(
					[
						`Content-Type: ${mimeType}; name="export.dat"`,
						"Content-Transfer-Encoding: base64",
						`Content-Disposition: attachment; filename="export.dat"`,
						"",
						data,
					],
					"\n",
				),
			() => `% Topic: claims.raw Partition: ${String(rng.int(12))} Offset: ${rng.digits(6)}\n${data}`,
		] as const;

		return rng.pick(envelopes)();
	};

export const asGzipHex = (rng: Random) => (payload: string) => {
	const data = Hex.encode(gzip(payload));
	const id = rng.digits(5);

	const envelopes = [
		() => ` id    | encoding | payload\n-------+----------+---------\n ${id} | gzip     | \\x${data}\n(1 row)`,
		() => `outbox_event id=${uuid(rng)} encoding=gzip payload_hex=${data}`,
		() => `>>> row["payload"].hex()\n'${data}'`,
		() => compactJson({ id: Number(id), contentEncoding: "gzip", payloadHex: data }),
	] as const;

	return rng.pick(envelopes)();
};

/**
 * Cuts the payload in two through the middle of `canary`, so neither half holds it whole. Returns the halves and the
 * canary's two parts, in order.
 */
export const splitPayload = ({ payload, canary }: { readonly payload: string; readonly canary: string }) => {
	const start = Option.getOrElse(Str.indexOf(canary)(payload), () => 0);
	const at = start + Math.floor(canary.length / 2);

	return {
		halves: [Str.slice(0, at)(payload), Str.slice(at)(payload)] as const,
		parts: [Str.slice(0, at - start)(canary), Str.slice(at - start)(canary)] as const,
	};
};
