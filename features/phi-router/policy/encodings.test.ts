import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as Str from "effect/String";

import { judgedOne, pieceOf, run, type Script } from "./engine.fixture.ts";
import { Finding, Verdict } from "./engine.ts";

const judged = (text: string, script: Script) => judgedOne({ piece: pieceOf(text), script });

const codePoints = (text: string) => Arr.getSomes(Arr.map(Arr.fromIterable(text), Str.codePointAt(0)));

const utf16 = (text: string, littleEndian: boolean) => {
	const bytes = new Uint8Array(text.length * 2);
	const view = new DataView(bytes.buffer);

	for (const [index, unit] of codePoints(text).entries()) {
		view.setUint16(index * 2, unit, littleEndian);
	}

	return bytes;
};

const latin1 = (text: string) => Uint8Array.from(codePoints(text));

for (const [encoding, text, bytes] of [
	["UTF-16LE", "Marisol Quintero has HIV", utf16("Marisol Quintero has HIV", true)],
	["UTF-16BE", "Marisol Quintero has HIV", utf16("Marisol Quintero has HIV", false)],
	["UTF-16LE", "Пациент Иванов, ВИЧ", utf16("Пациент Иванов, ВИЧ", true)],
	["Latin-1", "Señora Pérez tiene VIH", latin1("Señora Pérez tiene VIH")],
] as const) {
	test(`short ${encoding} text reaches the judge decoded: ${text}`, () =>
		run(
			Effect.gen(function* () {
				const { verdicts, fresh } = yield* judged(`blob ${Encoding.Base64.encode(bytes)}`, { score: () => 0 });

				expect(verdicts).toEqual([Verdict.Cleared({ by: "judge" })]);
				expect(Arr.join(fresh, "")).toContain(text);
			}),
		));
}

test("long UTF-16LE text is judged, not sealed as binary", () =>
	run(
		Effect.gen(function* () {
			const text = "Discharge note: Marisol Quintero, admitted with pneumonia, discharged on day four.";
			const encoded = Encoding.Base64.encode(utf16(text, true));
			const { verdicts, fresh } = yield* judged(`blob ${encoded}`, { score: () => 0 });

			expect(verdicts).toEqual([Verdict.Cleared({ by: "judge" })]);
			expect(Arr.join(fresh, "")).toContain(text);
		}),
	));

const percentEncoded = (bytes: Uint8Array) =>
	Arr.join(
		Arr.map(Arr.fromIterable(bytes), (byte) => `%${Str.padStart(2, "0")(byte.toString(16))}`),
		"",
	);

/** Seals only on the plain note, so a piece seals exactly when the judge was shown a correct reading. */
const seesNote = (plain: string): Script => ({
	score: ({ piece }) => (Str.includes(plain)(piece) ? 0.9 : 0),
	kind: () => "patient-name",
});

for (const [label, plain, bytes] of [
	["short mixed-script UTF-16LE", "Αννα HIV", utf16("Αννα HIV", true)],
	["NUL-terminated UTF-16LE", "Marisol Quintero has HIV", utf16("Marisol Quintero has HIV\0", true)],
	["accented Latin-1", "Íñés HIV.", latin1("Íñés HIV.")],
	["66-byte mixed-script UTF-16LE", "Иван HIV", utf16(`Иван HIV${Str.repeat(25)(" ")}`, true)],
	[
		"long UTF-16LE whose private-use glyph leaves only the byte-swapped reading text-like:",
		"Иван HIV",
		utf16(`Иван HIV${Str.repeat(25)(" ")}\uE0A0`, true),
	],
] as const) {
	test(`${label} text reaches the judge as written: ${plain}`, () =>
		run(
			Effect.gen(function* () {
				const { verdicts } = yield* judged(`q=${percentEncoded(bytes)}`, seesNote(plain));

				expect(verdicts).toEqual([
					Verdict.Sealed({ finding: Finding.Judge({ score: 0.9, kind: "patient-name" }) }),
				]);
			}),
		));
}
