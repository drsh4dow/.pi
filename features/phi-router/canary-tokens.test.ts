import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { foundIn, seenOn, tokensOf } from "./canary-tokens.ts";
import { cleanReachOf, failed, type Outcome } from "./corpus-wire-table.ts";
import { gzip } from "./corpus/encodings.ts";
import type { Case, Message } from "./corpus/manifest.ts";

const mrn = "MRN 4417-2290";

const record = `{"patient":"Synthetic Person","mrn":"${mrn}","diagnosis":"E11.9"}`;

const pixel = { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" };

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const phiCase = (entry: "user" | "tool-result", messages: readonly [Message, ...Array<Message>]) =>
	({
		id: "t-1",
		expect: "phi",
		strata: { identifier: "mrn", carrier: "fhir-json", transform: "plain", entry },
		canaries: [mrn],
		fragments: [],
		messages,
	}) satisfies Case;

const outcome: Outcome = {
	id: "t-1",
	expect: "phi",
	strata: [],
	personal: 0,
	ent: 0,
	leaked: [],
	unsealed: [],
	fragments: [],
	missing: [],
	broken: Option.none(),
};

const seen = Effect.fn("seen")(function* (
	subject: Case,
	sent: { readonly personal: ReadonlyArray<string>; readonly ent: ReadonlyArray<string> },
) {
	const tracked = yield* tokensOf(subject);
	const personal = yield* Effect.forEach(sent.personal, (content) => encodeJson({ messages: [{ content }] }));
	const ent = yield* Effect.forEach(sent.ent, (content) => encodeJson({ messages: [{ content }] }));

	return seenOn({ tracked, personal, ent });
});

const textsOf = (subject: Case) =>
	Arr.flatMap(subject.messages, (message) => ("text" in message ? [message.text] : []));

const nothing = { leaked: [], unsealed: [], fragments: [], missing: [] };

test("a complete canary in a personal body is a leak, and the message that held it is unsealed", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const ask = "Can you check why the importer rejects the row below?";

			const subject = phiCase("user", [
				{ role: "user", text: ask },
				{ role: "user", text: `${ask}\n${record}` },
			]);

			const onEnt = yield* seen(subject, { personal: [ask], ent: textsOf(subject) });
			const onPersonal = yield* seen(subject, { personal: textsOf(subject), ent: textsOf(subject) });

			expect(onEnt).toEqual(nothing);
			expect(onPersonal.leaked).toEqual([mrn]);
			expect(onPersonal.unsealed.length).toBe(1);
		}),
	));

test("a sealed message with its identifier redacted still fails on a personal body, as unsealed and not leaked", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const text = `${record} fails the importer.`;
			const subject = phiCase("user", [{ role: "user", text }]);

			const result = yield* seen(subject, { personal: [Str.replace(mrn, "[redacted]")(text)], ent: [text] });

			expect(result.leaked).toEqual([]);
			expect(result.unsealed.length).toBe(1);
			expect(failed({ ...outcome, ...result })).toBe(true);
		}),
	));

test("a canary carried in base64 or gzip hex leaks as the encoded run", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const base64 = Encoding.Base64.encode(record);
			const hex = Encoding.Hex.encode(gzip(record));
			const encoded = phiCase("tool-result", [{ role: "tool", text: `payload: ${base64}\n(1 row)` }]);
			const zipped = phiCase("tool-result", [{ role: "tool", text: ` 29637 | gzip | \\x${hex}\n(1 row)` }]);

			const fromBase64 = yield* seen(encoded, { personal: [base64], ent: textsOf(encoded) });
			const fromHex = yield* seen(zipped, { personal: [hex], ent: textsOf(zipped) });

			expect(fromBase64.leaked).toEqual([base64]);
			expect(fromHex.leaked).toEqual([hex]);
		}),
	));

test("one part of a split canary on a personal body is a fragment, and every part is a leak", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const first = `${Str.repeat(60)("a")}MRN 4417-`;
			const second = `2290${Str.repeat(60)("b")}`;

			const subject: Case = {
				...phiCase("user", [
					{ role: "user", text: first },
					{ role: "user", text: second },
				]),
				canaryParts: { [mrn]: ["MRN 4417-", "2290"] },
			};

			const one = yield* seen(subject, { personal: [first], ent: [first, second] });
			const both = yield* seen(subject, { personal: [first, second], ent: [first, second] });

			expect(one.leaked).toEqual([]);
			expect(one.fragments.length).toBe(1);
			expect(failed({ ...outcome, ...one })).toBe(false);
			expect(both.leaked).toEqual([mrn]);
		}),
	));

test("a fragment on a personal body is counted and passes", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const subject: Case = {
				id: "c-1",
				expect: "clean",
				strata: { negative: "fragment" },
				canaries: [],
				fragments: ["Wexford"],
				messages: [{ role: "user", text: "The lookup failed for the surname Wexford." }],
			};

			const result = yield* seen(subject, { personal: textsOf(subject), ent: [] });

			expect(result).toEqual({ ...nothing, fragments: ["Wexford"] });
			expect(failed({ ...outcome, ...result })).toBe(false);
		}),
	));

test("an image canary is a run of its base64 data, and leaks when the image reaches a personal body", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const canary = Str.slice(4, 28)(pixel.data);
			const subject: Case = { ...phiCase("user", [{ role: "user", image: pixel }]), canaries: [canary] };

			const onEnt = yield* seen(subject, { personal: [], ent: [pixel.data] });
			const onPersonal = yield* seen(subject, { personal: [pixel.data], ent: [pixel.data] });

			expect(onEnt).toEqual(nothing);
			expect(onPersonal.leaked).toEqual([canary]);
		}),
	));

test("PHI no ent body carried, or a canary no message carries, is missing", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const subject = phiCase("user", [{ role: "user", text: `The row is ${record}` }]);
			const absent = phiCase("user", [{ role: "user", text: "Nothing to see." }]);

			const undelivered = yield* seen(subject, { personal: [], ent: [] });
			const untracked = yield* seen(absent, { personal: [], ent: [] });

			expect(undelivered.missing).toContain(mrn);
			expect(untracked.missing).toEqual([mrn]);
		}),
	));

test("a token with a line break is found in a JSON body, where it is escaped", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const token = "line one\nline two";
			const body = yield* encodeJson({ messages: [{ content: `x ${token} y` }] });

			expect(foundIn({ bodies: [body], tokens: [token, "line three"] })).toEqual([token]);
		}),
	));

test("the clean report gives each clean case's lane and the share that reached a personal mock", () => {
	const report = cleanReachOf([
		{ ...outcome, id: "c-1", expect: "clean", personal: 2 },
		{ ...outcome, id: "c-2", expect: "clean", personal: 0 },
		{ ...outcome, id: "p-1", expect: "phi", personal: 3 },
	]);

	expect(report).toEqual({
		reached: 1,
		lines: ["c-1\tpersonal", "c-2\tent only", "clean cases on a personal mock: 1 of 2 (50%)"],
	});
});
