import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { defaultSeed, encodeCorpus, generate } from "./generate.ts";
import { loadImages } from "./images.ts";
import {
	type Case,
	CaseFromJsonLine,
	Carrier,
	Entry,
	Identifier,
	type Message,
	Negative,
	type PhiCase,
	Transform,
} from "./manifest.ts";
import { synthetic } from "./synthetic.ts";

const images = await Effect.runPromise(loadImages.pipe(Effect.provide(NodeServices.layer)));
const corpus = generate({ seed: defaultSeed, images });
const phiCases = Arr.filter(corpus, (item) => item.expect === "phi");
const cleanCases = Arr.filter(corpus, (item) => item.expect === "clean");

const textsOf = (item: Case) => Arr.flatMap(item.messages, (message) => ("text" in message ? [message.text] : []));

const imagesOf = (item: Case) =>
	Arr.flatMap(item.messages, (message) => ("image" in message ? [message.image.data] : []));

const plainViews = (item: Case) => {
	const texts = textsOf(item);
	const roles: ReadonlyArray<Message["role"]> = ["system", "user", "assistant", "tool"];

	const byRole = Arr.map(roles, (role) =>
		Arr.join(
			Arr.flatMap(item.messages, (message) => ("text" in message && message.role === role ? [message.text] : [])),
			"",
		),
	);

	return [...texts, ...byRole, Arr.join(texts, ""), ...imagesOf(item)];
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

type Phi = typeof PhiCase.Type;

const countOf = (counts: ReadonlyMap<string, number>, value: string): number => counts.get(value) ?? 0;

const misplacedInImage = ({ canary, data }: { readonly canary: string; readonly data: string }): boolean =>
	canary.length < 24 || Option.getOrElse(Str.indexOf(canary)(data), () => 0) < 8;

const lostCanaries = (item: Phi, decoded: ReadonlyArray<string>): ReadonlyArray<string> => {
	const plain = plainViews(item);
	const encoded = item.strata.transform === "base64" || item.strata.transform === "gzip-hex";

	return Arr.flatMap(item.canaries, (canary) => {
		const inPlain = Arr.some(plain, Str.includes(canary));
		const recovered = encoded ? Arr.some(decoded, Str.includes(canary)) && !inPlain : inPlain;

		return recovered ? [] : [`${item.id} ${canary}`];
	});
};

const badlySplit = (item: Phi): boolean => {
	const cuts = Rec.toEntries(item.canaryParts ?? {});
	const texts = textsOf(item);

	const wrong = Arr.some(cuts, ([canary, parts]) => {
		const holders = Arr.map(parts, (part) => Arr.findFirstIndex(texts, Str.includes(part)));

		return (
			Arr.join(parts, "") !== canary ||
			Arr.some(texts, Str.includes(canary)) ||
			new Set(Arr.map(holders, (holder) => Option.getOrElse(holder, () => -1))).size !== parts.length ||
			Arr.some(holders, Option.isNone)
		);
	});

	return cuts.length === 0 || wrong;
};

const partsOutsideSplit = (item: Phi): boolean => item.strata.transform !== "split" && item.canaryParts !== undefined;

const quotesCanaryBack = (item: Phi): boolean =>
	Arr.some(
		item.messages,
		(message) =>
			message.role === "assistant" &&
			"text" in message &&
			Arr.some(item.canaries, (canary) => Str.includes(canary)(message.text)),
	);

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

test("ids, canaries and fragments are unique across the file, at least 8 and 6 characters long", () => {
	const ids = Arr.map(corpus, ({ id }) => id);
	const canaries = Arr.flatMap(corpus, ({ canaries: planted }) => planted);
	const fragments = Arr.flatMap(corpus, ({ fragments: planted }) => planted);

	expect(new Set(ids).size).toBe(ids.length);
	expect(new Set([...canaries, ...fragments]).size).toBe(canaries.length + fragments.length);
	expect(Arr.filter(canaries, (canary) => canary.length < 8)).toEqual([]);
	expect(Arr.filter(fragments, (fragment) => fragment.length < 6)).toEqual([]);
});

test("an image canary is a base64 run of 24 or more characters from past its JPEG header", () => {
	const screenshots = Arr.filter(phiCases, ({ strata }) => strata.carrier === "screenshot");

	const imageCanaries = Arr.flatMap(screenshots, (item) =>
		Arr.map(item.canaries, (canary) => ({ canary, data: Arr.join(imagesOf(item), "") })),
	);

	const misplaced = Arr.filter(imageCanaries, misplacedInImage);

	expect(imageCanaries.length).toBeGreaterThan(0);
	expect(misplaced).toEqual([]);
});

test("every fragment case plants its fragments in its own text", () => {
	const fragmentCases = Arr.filter(cleanCases, ({ strata }) => strata.negative === "fragment");

	const missing = Arr.flatMap(fragmentCases, (item) =>
		Arr.filter(item.fragments, (fragment) => !Arr.some(textsOf(item), Str.includes(fragment))),
	);

	expect(Arr.every(fragmentCases, ({ fragments }) => fragments.length > 0)).toBe(true);
	expect(missing).toEqual([]);
});

const listed = (text: string) =>
	Arr.some(synthetic.exact, (identity) => Str.includes(identity)(text)) ||
	Arr.some(synthetic.prefixes, (prefix) => Str.includes(prefix)(text));

test("a synthetic-listed case names a listed identity, and no PHI case holds one", () => {
	const syntheticCases = Arr.filter(cleanCases, ({ strata }) => strata.negative === "synthetic-listed");
	const unlisted = Arr.filter(syntheticCases, (item) => !Arr.some(textsOf(item), listed));
	const phiListed = Arr.filter(phiCases, (item) => Arr.some(textsOf(item), listed));

	expect(syntheticCases.length).toBeGreaterThan(0);
	expect(Arr.map(unlisted, ({ id }) => id)).toEqual([]);
	expect(Arr.map(phiListed, ({ id }) => id)).toEqual([]);
});

test("every negative class has at least 30 clean cases, and none holds a canary", () => {
	const counts = countBy(Arr.map(cleanCases, ({ strata }) => strata.negative));
	const canaries = Arr.flatMap(phiCases, ({ canaries: planted }) => planted);

	const leaked = Arr.filter(cleanCases, (item) =>
		Arr.some(textsOf(item), (text) => Arr.some(canaries, (canary) => Str.includes(canary)(text))),
	);

	expect(Arr.filter(Negative.literals, (negative) => countOf(counts, negative) < 30)).toEqual([]);
	expect(Arr.map(leaked, ({ id }) => id)).toEqual([]);
});

test("every value of every PHI axis has at least 20 cases, except buried, which has 8 to 12", () => {
	const axes = [
		["identifier", Identifier.literals],
		["carrier", Carrier.literals],
		["transform", Arr.filter(Transform.literals, (transform) => transform !== "buried")],
		["entry", Entry.literals],
	] as const;

	const short = Arr.flatMap(axes, ([axis, values]) => {
		const counts = countBy(Arr.map(phiCases, ({ strata }) => strata[axis]));

		return Arr.map(
			Arr.filter(values, (value) => countOf(counts, value) < 20),
			(value) => `${axis}=${value}`,
		);
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
				Effect.map(decodedViews(item), (decoded) => lostCanaries(item, decoded)),
			);

			expect(Arr.flatten(lost)).toEqual([]);
		}),
	));

test("a split case cuts its canary into parts in separate messages, and no message holds it whole", () => {
	const splits = Arr.filter(phiCases, ({ strata }) => strata.transform === "split");

	const broken = Arr.filter(splits, badlySplit);
	const unsplit = Arr.filter(phiCases, partsOutsideSplit);

	expect(splits.length).toBeGreaterThan(0);
	expect(Arr.map(broken, ({ id }) => id)).toEqual([]);
	expect(Arr.map(unsplit, ({ id }) => id)).toEqual([]);
});

test("in an ent-reply case, the assistant quotes a canary back", () => {
	const replies = Arr.filter(phiCases, ({ strata }) => strata.entry === "ent-reply");

	const silent = Arr.filter(replies, (item) => !quotesCanaryBack(item));

	expect(replies.length).toBeGreaterThan(0);
	expect(Arr.map(silent, ({ id }) => id)).toEqual([]);
});

test("the same seed gives byte-identical output and another seed differs", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const first = yield* encodeCorpus(corpus);
			const again = yield* encodeCorpus(generate({ seed: defaultSeed, images }));
			const other = yield* encodeCorpus(generate({ seed: defaultSeed + 1, images }));

			expect(again === first).toBe(true);
			expect(other === first).toBe(false);
		}),
	));
