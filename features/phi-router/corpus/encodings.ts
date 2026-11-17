import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";

const crcTable = Arr.makeBy(256, (index) => {
	let crc = index;

	for (let bit = 0; bit < 8; bit += 1) {
		crc = (crc & 1) === 1 ? (3_988_292_384 ^ (crc >>> 1)) >>> 0 : crc >>> 1;
	}

	return crc;
});

const crc32 = (bytes: ReadonlyArray<number>) => {
	let crc = 4_294_967_295;

	for (const byte of bytes) {
		crc = ((crcTable[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8)) >>> 0;
	}

	return (crc ^ 4_294_967_295) >>> 0;
};

const littleEndian32 = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24];

/** A Huffman code's bits, most significant first, the order deflate packs them in. */
const codeBits = (code: number, length: number) => Arr.makeBy(length, (index) => (code >>> (length - 1 - index)) & 1);

const literalBits = (byte: number) => (byte < 144 ? codeBits(48 + byte, 8) : codeBits(400 + byte - 144, 9));

/** One final deflate block with the fixed Huffman code and literals only (RFC 1951, 3.2.6). */
const deflateFixed = (bytes: ReadonlyArray<number>) => {
	const header = [1, 1, 0];
	const endOfBlock = codeBits(0, 7);
	const bits = [...header, ...Arr.flatMap(bytes, literalBits), ...endOfBlock];

	return Arr.map(Arr.chunksOf(bits, 8), (octet) =>
		Arr.reduce(octet, 0, (packed, bit, index) => packed | (bit << index)),
	);
};

/** A complete gzip member (RFC 1952) with a zero mtime, so the same text always gives the same bytes. */
export const gzip = (text: string) => {
	const bytes = Arr.fromIterable(new TextEncoder().encode(text));
	const header = [31, 139, 8, 0, 0, 0, 0, 0, 0, 3];

	return Uint8Array.from([
		...header,
		...deflateFixed(bytes),
		...littleEndian32(crc32(bytes)),
		...littleEndian32(bytes.length),
	]);
};

type Json = string | number | boolean | null | ReadonlyArray<Json> | JsonObject;

export interface JsonObject {
	readonly [key: string]: Json;
}

const escapes = new Map([
	['"', String.raw`\"`],
	["\\", String.raw`\\`],
	["\n", String.raw`\n`],
	["\r", String.raw`\r`],
	["\t", String.raw`\t`],
]);

const jsonString = (text: string) => {
	const escaped = Arr.map(Arr.fromIterable(text), (char) => escapes.get(char) ?? char);

	return `"${Arr.join(escaped, "")}"`;
};

const isList = (node: Json): node is ReadonlyArray<Json> => Arr.isArray(node);

const writeJson = (indent: string) => {
	const colon = indent === "" ? ":" : ": ";

	const write = (node: Json, depth: string): string => {
		if (Predicate.isString(node)) {
			return jsonString(node);
		}

		if (node === null || Predicate.isNumber(node) || Predicate.isBoolean(node)) {
			return String(node);
		}

		const inner = indent === "" ? "" : `\n${depth}${indent}`;
		const outer = indent === "" ? "" : `\n${depth}`;

		const items = isList(node)
			? Arr.map(node, (item) => write(item, depth + indent))
			: Arr.map(Rec.toEntries(node), ([key, item]) => `${jsonString(key)}${colon}${write(item, depth + indent)}`);

		const [open, close] = isList(node) ? ["[", "]"] : ["{", "}"];

		return Arr.isArrayNonEmpty(items)
			? `${open}${inner}${Arr.join(items, `,${inner}`)}${outer}${close}`
			: `${open}${close}`;
	};

	return (value: Json) => write(value, "");
};

export const compactJson = writeJson("");

export const prettyJson = writeJson("  ");
