import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { SafeHarbor } from "../policy/index.ts";
import { defaultSeed, encodeCorpus, generate } from "./generate.ts";
import { diagnoses } from "./health.ts";
import { type Case, CaseFromJsonLine, Carrier, Entry, type Message, Negative, Transform } from "./manifest.ts";

const corpus = generate(defaultSeed);
const phiCases = Arr.filter(corpus, (item) => item.expect === "phi");

const textsOf = (item: Case) => Arr.flatMap(item.messages, (message) => ("text" in message ? [message.text] : []));

const plainViews = (item: Case) => {
	const texts = textsOf(item);
	const roles: ReadonlyArray<Message["role"]> = ["system", "user", "assistant", "tool"];

	const byRole = Arr.map(roles, (role) =>
		Arr.join(
			Arr.flatMap(item.messages, (message) => ("text" in message && message.role === role ? [message.text] : [])),
			"",
		),
	);

	return [...texts, ...byRole, Arr.join(texts, "")];
};

const gunzip = (bytes: Uint8Array) =>
	Effect.promise(() => {
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));

		return new Response(stream).text();
	});

const runsIn = (texts: ReadonlyArray<string>, pattern: RegExp) =>
	Arr.flatMap(texts, (text) => Arr.map(Arr.fromIterable(Str.matchAll(pattern)(text)), (match) => match[0]));

const decodedViews = (item: Case) => {
	const texts = textsOf(item);

	const base64 = Arr.flatMap(runsIn(texts, /[A-Za-z0-9+/]{40,}={0,2}/gu), (run) =>
		Base64.decodeString(run).pipe(Result.getSuccess, Option.toArray),
	);

	const gzipped = Arr.flatMap(runsIn(texts, /1f8b08[0-9a-f]+/gu), (run) =>
		Hex.decode(run).pipe(Result.getSuccess, Option.toArray),
	);

	return Effect.map(Effect.forEach(gzipped, gunzip), (gunzipped) => [...base64, ...gunzipped]);
};

const countBy = (values: ReadonlyArray<string>) => {
	const counts = new Map<string, number>();

	for (const value of values) {
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}

	return counts;
};

test("the default corpus round-trips line by line through the manifest schema", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const manifest = yield* encodeCorpus(corpus);
			const lines = Str.split("\n")(Str.trimEnd(manifest));
			const decoded = yield* Effect.forEach(lines, (line) => Schema.decodeEffect(CaseFromJsonLine)(line));

			const decodedIds: ReadonlyArray<string> = Arr.map(decoded, ({ id }) => id);

			expect(decodedIds).toEqual(Arr.map(corpus, ({ id }) => id));
		}),
	));

test("ids and canaries are unique across the file, and every canary has at least 8 characters", () => {
	const ids = Arr.map(corpus, ({ id }) => id);
	const canaries = Arr.flatMap(corpus, ({ canaries: planted }) => planted);

	expect(new Set(ids).size).toBe(ids.length);
	expect(new Set(canaries).size).toBe(canaries.length);
	expect(Arr.filter(canaries, (canary) => canary.length < 8)).toEqual([]);
});

test("every negative class has at least 30 clean cases, and none holds a canary", () => {
	const cleanCases = Arr.filter(corpus, (item) => item.expect === "clean");
	const counts = countBy(Arr.map(cleanCases, ({ strata }) => strata.negative));
	const canaries = Arr.flatMap(phiCases, ({ canaries: planted }) => planted);

	const leaked = Arr.filter(cleanCases, (item) =>
		Arr.some(textsOf(item), (text) => Arr.some(canaries, (canary) => Str.includes(canary)(text))),
	);

	expect(Arr.filter(Negative.literals, (negative) => (counts.get(negative) ?? 0) < 30)).toEqual([]);
	expect(Arr.map(leaked, ({ id }) => id)).toEqual([]);
});

test("every value of every PHI axis has at least 20 cases, except buried, which has 8 to 12", () => {
	const axes = [
		["identifier", SafeHarbor.literals],
		["carrier", Carrier.literals],
		["transform", Arr.filter(Transform.literals, (transform) => transform !== "buried")],
		["entry", Entry.literals],
	] as const;

	const short = Arr.flatMap(axes, ([axis, values]) => {
		const counts = countBy(Arr.map(phiCases, ({ strata }) => strata[axis]));

		return Arr.flatMap(values, (value) => ((counts.get(value) ?? 0) < 20 ? [`${axis}=${value}`] : []));
	});

	const buried = Arr.filter(phiCases, ({ strata }) => strata.transform === "buried").length;

	expect(short).toEqual([]);
	expect(buried).toBeGreaterThanOrEqual(8);
	expect(buried).toBeLessThanOrEqual(12);
});

test("a buried case carries at least 500,000 characters around its PHI", () => {
	const buried = Arr.filter(phiCases, ({ strata }) => strata.transform === "buried");

	const thin = Arr.filter(
		buried,
		(item) => Arr.reduce(textsOf(item), 0, (total, text) => total + text.length) < 500_000,
	);

	expect(buried.length).toBeGreaterThan(0);
	expect(Arr.map(thin, ({ id }) => id)).toEqual([]);
});

test("every canary is recoverable from its case, and an encoded one only by decoding", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const lost = yield* Effect.forEach(phiCases, (item) =>
				Effect.map(decodedViews(item), (decoded) => {
					const plain = plainViews(item);
					const encoded = item.strata.transform === "base64" || item.strata.transform === "gzip-hex";

					return Arr.flatMap(item.canaries, (canary) => {
						const inPlain = Arr.some(plain, Str.includes(canary));
						const recovered = encoded ? Arr.some(decoded, Str.includes(canary)) && !inPlain : inPlain;

						return recovered ? [] : [`${item.id} ${canary}`];
					});
				}),
			);

			expect(Arr.flatten(lost)).toEqual([]);
		}),
	));

test("a split case never puts the whole identifier and its diagnosis code in one message", () => {
	const codes = Arr.flatMap(diagnoses, ({ code }) => [code, Str.replaceAll(".", "")(code)]);
	const splits = Arr.filter(phiCases, ({ strata }) => strata.transform === "split");

	const whole = Arr.flatMap(splits, (item) => {
		const [canary] = item.canaries;

		const together = Arr.some(
			textsOf(item),
			(text) => Str.includes(canary)(text) && Arr.some(codes, (code) => Str.includes(code)(text)),
		);

		return together ? [item.id] : [];
	});

	expect(splits.length).toBeGreaterThan(0);
	expect(whole).toEqual([]);
});

test("the same seed gives byte-identical output and another seed differs", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const first = yield* encodeCorpus(corpus);
			const again = yield* encodeCorpus(generate(defaultSeed));
			const other = yield* encodeCorpus(generate(defaultSeed + 1));

			expect(again === first).toBe(true);
			expect(other === first).toBe(false);
		}),
	));
