import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Str from "effect/String";

type Unexpandable = "binary" | "undecodable";

const maxDepth = 3;

const maxDecodedBytes = 4 * 1024 * 1024;

const shortBytes = 64;

const base64Run = /[\w+/-]{16,}={0,2}/gu;

/** Hex gzip: the magic `1f 8b`, deflate (`08`), and at least the 20 bytes of an empty member. */
const gzipHex = /(?<![\da-f])1f8b08(?:[\da-f]{2}){17,}(?![\da-f])/giu;

const percentRun = /(?<![!-~])[!-$&-~]*(?:%[\dA-Fa-f]{2}[!-$&-~]*)+/gu;

const looksBase64 = (run: string) =>
	/[A-Z]/u.test(run) && /[a-z]/u.test(run) && /\d/u.test(run) && !(/[+/]/u.test(run) && /[-_]/u.test(run));

const wordLike = /(?<![^+/_-])[\da-z]+(?![^+/_-])|[a-z]{4,}/gu;

const readsAsWords = (run: string) =>
	2 * Arr.reduce([...Str.matchAll(wordLike)(run)], 0, (size, [word]) => size + word.length) > run.length;

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
	const joined = new Uint8Array(Arr.reduce(chunks, 0, (size, chunk) => size + chunk.length));
	let offset = 0;

	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.length;
	}

	return joined;
};

const fromBase64 = (run: string) => {
	const urlAlphabet = Str.replaceAll("/", "_")(Str.replaceAll("+", "-")(run));

	return Result.getSuccess(Encoding.Base64Url.decode(urlAlphabet));
};

const encoder = new TextEncoder();

const percentPiece = /%(?<escaped>[\dA-Fa-f]{2})|[^%]+/gu;

const fromPercent = (run: string) =>
	concat(
		Arr.map([...Str.matchAll(percentPiece)(run)], (piece) => {
			const escaped = piece.groups?.["escaped"];

			return escaped === undefined
				? encoder.encode(Str.replaceAll("+", " ")(piece[0]))
				: Uint8Array.of(Number.parseInt(escaped, 16));
		}),
	);

const isGzip = (bytes: Uint8Array) => bytes[0] === 31 && bytes[1] === 139;

const undecodable = Effect.fail<Unexpandable>("undecodable");

const gunzip = (gzip: Uint8Array) =>
	new Blob([new Uint8Array(gzip)]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();

const readUpTo = Effect.fn("readUpTo")(function* (reader: ReturnType<typeof gunzip>, room: number) {
	const chunks: Array<Uint8Array> = [];
	let size = 0;

	for (;;) {
		const next = yield* Effect.tryPromise({ try: () => reader.read(), catch: (): Unexpandable => "undecodable" });

		if (next.done) {
			return concat(chunks);
		}

		size += next.value.length;

		if (size > room) {
			return yield* undecodable;
		}

		chunks.push(next.value);
	}
});

const inflate = (gzip: Uint8Array, room: number) =>
	Effect.acquireUseRelease(
		Effect.sync(() => gunzip(gzip)),
		(reader) => readUpTo(reader, room),
		(reader) => Effect.ignore(Effect.tryPromise({ try: () => reader.cancel(), catch: () => "cancel failed" })),
	);

const utf8 = new TextDecoder("utf-8", { fatal: true });

const decodeUtf8 = Option.liftThrowable((bytes: Uint8Array) => utf8.decode(bytes));

const isControl = (byte: number) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127;

const printable = (bytes: Uint8Array) => (bytes.some(isControl) ? Option.none() : decodeUtf8(bytes));

const legacyDecoders = Arr.map(["utf-16le", "utf-16be", "latin1"] as const, (label) => new TextDecoder(label));

const legacyReadings = (bytes: Uint8Array) => Arr.map(legacyDecoders, (decoder) => decoder.decode(bytes));

/**
 * A character text in that encoding would not hold: a control, a surrogate, a private-use or unassigned code point, or
 * a decoding error. NUL is allowed, since it pads ASCII read as UTF-16 and ends C strings.
 */
const outsideText = /[^\P{C}\p{Cf}\0\t\n\r]|\uFFFD/u;

const isText = (reading: string) => !outsideText.test(reading);

const readsAsText = (bytes: Uint8Array) => Option.isSome(printable(bytes)) || Arr.some(legacyReadings(bytes), isText);

const legible = (reading: string) => Str.replaceAll(/[^\P{Cc}\t\n\r]/gu, " ")(Str.replaceAll("\0", "")(reading));

/**
 * What the judge reads for decoded bytes: the text when they are printable UTF-8, else every legacy reading side by
 * side, since no test can tell which one is meant. Long bytes that read as text in no encoding have none.
 */
const readingsOf = (bytes: Uint8Array) =>
	Option.orElse(Option.map(printable(bytes), Arr.of), () => {
		const readings = legacyReadings(bytes);

		return bytes.length <= shortBytes || Arr.some(readings, isText)
			? Option.some(Arr.map(readings, legible))
			: Option.none();
	});

const fromBase64Run = (run: string) => {
	if (!looksBase64(run)) {
		return Option.none();
	}

	const bytes = fromBase64(run);

	return readsAsWords(run) ? Option.filter(bytes, readsAsText) : bytes;
};

const decoders: ReadonlyArray<{
	readonly pattern: RegExp;
	readonly decode: (run: string) => Option.Option<Uint8Array>;
}> = [
	{ pattern: base64Run, decode: fromBase64Run },
	{ pattern: gzipHex, decode: (run) => Result.getSuccess(Encoding.Hex.decode(run)) },
	{ pattern: percentRun, decode: (run) => Option.some(fromPercent(run)) },
];

/**
 * Turns each text into scannable text: the text followed by every reading of every payload decoded from it, recursively.
 * Fails closed as `binary` on decoded bytes over `shortBytes` that read as text in no encoding, and as `undecodable` on a
 * corrupt gzip, on more than `maxDecodedBytes` decoded, or on a payload that still decodes to text below `maxDepth`
 * levels.
 */
export const expand = Effect.fn("expand")(function* (texts: ReadonlyArray<string>) {
	let room = maxDecodedBytes;

	const bytesOf = Effect.fn("bytesOf")(function* (encoded: Uint8Array) {
		const bytes = isGzip(encoded) ? yield* inflate(encoded, room) : encoded;

		room -= bytes.length;

		return room < 0 ? yield* undecodable : bytes;
	});

	const decodedIn = (text: string, level: number): Effect.Effect<ReadonlyArray<string>, Unexpandable> =>
		Effect.gen(function* () {
			const found: Array<string> = [];

			for (const { pattern, decode } of decoders) {
				for (const encoded of Arr.getSomes(Arr.map([...Str.matchAll(pattern)(text)], ([run]) => decode(run)))) {
					const bytes = yield* bytesOf(encoded);
					const decoded = yield* textsOf(bytes, level);

					found.push(...decoded);
				}
			}

			return found;
		});

	const textsOf = (bytes: Uint8Array, level: number): Effect.Effect<ReadonlyArray<string>, Unexpandable> =>
		Option.match(readingsOf(bytes), {
			onNone: () => Effect.fail<Unexpandable>("binary"),
			onSome: (readings) =>
				level === maxDepth
					? undecodable
					: Effect.map(
							Effect.forEach(readings, (reading) =>
								Effect.map(decodedIn(reading, level + 1), (deeper) => [reading, ...deeper]),
							),
							Arr.flatten,
						),
		});

	return yield* Effect.forEach(texts, (text) =>
		Effect.map(decodedIn(text, 0), (decoded) => Arr.join([text, ...decoded], "\n")),
	);
});
