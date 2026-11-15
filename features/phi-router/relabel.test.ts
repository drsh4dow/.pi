import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { Classify } from "./decisions.ts";
import { laneLine, laneOf, lanesOf, type Said, scripted, sessionsFrom, sessionText } from "./relabel.fixture.ts";
import { audit, conversationAt, type Lanes, parseLanes, personalShare, sampleOf } from "./relabel.ts";

test("the character share counts only would-be-personal records and ignores direct ones", () => {
	const records = [
		laneOf({ session: "a", wouldBe: "ultra-a", chars: 300 }),
		laneOf({ session: "b", reason: "continuation", wouldBe: "ultra-b", chars: 100 }),
		laneOf({ session: "c", wouldBe: "ent", chars: 600 }),
		laneOf({ session: "d", reason: "direct", wouldBe: "ent", chars: 1000 }),
		laneOf({ session: "e", reason: "direct", wouldBe: "ultra-a", chars: 5000 }),
	];

	expect(personalShare(records)).toEqual({ personal: 400, routed: 1000 });
});

test("the same seed picks the same sample, of would-be-personal records only", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const records = [
				...Arr.makeBy(20, (index) => laneOf({ session: `personal-${String(index)}`, wouldBe: "ultra-b" })),
				...Arr.makeBy(20, (index) => laneOf({ session: `baa-${String(index)}`, wouldBe: "ent" })),
			];

			const first = yield* sampleOf({ records, size: 5, seed: 7 });
			const again = yield* sampleOf({ records, size: 5, seed: 7 });
			const other = yield* sampleOf({ records, size: 5, seed: 8 });

			expect(again).toEqual(first);
			expect(other).not.toEqual(first);
			expect(first).toHaveLength(5);
			expect(Arr.every([...first, ...other], ({ session }) => Str.startsWith("personal-")(session))).toBe(true);
		}),
	));

const opening: ReadonlyArray<Said> = [
	{ id: "e1", role: "user", text: "Rename the parser module." },
	{ id: "e2", role: "assistant", text: "Renamed it." },
	{ id: "e3", role: "user", text: "Now split the lexer out." },
];

test("a conversation rebuilt at an earlier leaf holds only the entries up to it", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const session = yield* sessionText({ session: "s-tree", turns: opening });
			const atLeaf = yield* conversationAt({ session, leaf: "e2" });
			const atMissing = yield* conversationAt({ session, leaf: "e9" });

			expect(atLeaf).toEqual(
				Option.some([
					{ role: "user", parts: [{ kind: "text", text: "Rename the parser module." }] },
					{ role: "assistant", parts: [{ kind: "text", text: "Renamed it." }] },
				]),
			);
			expect(atMissing).toEqual(Option.none());
		}),
	));

const syntheticChart = "Patient Jane Roe, DOB 1961-03-14, MRN 4471-0932-88, admitted with diabetic ketoacidosis.";

const charted: ReadonlyArray<Said> = [
	{ id: "e1", role: "user", text: `Seed the fixture with: ${syntheticChart}` },
	{ id: "e2", role: "assistant", text: "Seeded the fixture." },
];

const auditWith = (lanes: Effect.Effect<Lanes, Schema.SchemaError>, classify: Classify) =>
	Effect.gen(function* () {
		const clean = yield* sessionText({ session: "s-clean", turns: opening });
		const phi = yield* sessionText({ session: "s-chart", turns: charted });
		const readSession = sessionsFrom({ "s-clean": clean, "s-chart": phi });

		return yield* audit({ lanes: yield* lanes, readSession, classify, size: 50, seed: 1 });
	});

const twoPersonal = lanesOf([
	laneOf({ session: "s-clean", leaf: "e3", wouldBe: "ultra-a" }),
	laneOf({ session: "s-chart", leaf: "e2", wouldBe: "ultra-b" }),
]);

test("a judge that finds PHI in one record names its session and leaf, shows no content, and fails the run", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const report = yield* auditWith(
				twoPersonal,
				scripted((conversation) => Option.some(Str.includes("Jane Roe")(conversation) ? 0.05 : 0.01)),
			);

			const output = Arr.join(report.lines, "\n");
			const said = [...opening, ...charted, { text: "Jane Roe" }];

			expect(report.passed).toBe(false);
			expect(Arr.filter(report.lines, Str.startsWith("disagree"))).toEqual(["disagree: session s-chart leaf e2"]);
			expect(report.lines).toContain("sampled 2, agreed 1, disagreed 1, unjudged 0");
			expect(Arr.filter(said, ({ text }) => Str.includes(text)(output))).toEqual([]);
		}),
	));

test("a judge that finds every record clean passes the run", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const report = yield* auditWith(
				twoPersonal,
				scripted(() => Option.some(0.04)),
			);

			expect(report.passed).toBe(true);
			expect(report.lines).toContain("sampled 2, agreed 2, disagreed 0, unjudged 0");
		}),
	));

test("a judge error, a missing session file and a missing leaf each count unjudged and fail the run", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const lanes = lanesOf([
				laneOf({ session: "s-clean", leaf: "e3" }),
				laneOf({ session: "s-gone", leaf: "e1" }),
				laneOf({ session: "s-chart", leaf: "e7" }),
			]);

			const report = yield* auditWith(
				lanes,
				scripted(() => Option.none()),
			);

			expect(report.passed).toBe(false);
			expect(report.lines).toContain("unjudged (judge-error): session s-clean leaf e3");
			expect(report.lines).toContain("unjudged (no-session): session s-gone leaf e1");
			expect(report.lines).toContain("unjudged (no-leaf): session s-chart leaf e7");
			expect(report.lines).toContain("sampled 3, agreed 0, disagreed 0, unjudged 3");
		}),
	));

test("an undecodable lane line is reported by file and line and fails the run", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const lanes = Effect.map(laneLine(laneOf({ session: "s-bad", wouldBe: "ent" })), (line) =>
				parseLanes([{ name: "s-bad.jsonl", text: `${line}\n{"time":\n` }]),
			);

			const report = yield* auditWith(
				lanes,
				scripted(() => Option.some(0)),
			);

			expect(report.passed).toBe(false);
			expect(report.lines).toContain("undecodable lane line: s-bad.jsonl:2");
		}),
	));

test("lane logs with no would-be-personal record pass and say there was nothing to relabel", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const report = yield* auditWith(
				lanesOf([laneOf({ session: "s-baa", wouldBe: "ent" })]),
				scripted(() => Option.some(1)),
			);

			expect(report.passed).toBe(true);
			expect(report.lines).toContain("no would-be-personal records: nothing to relabel");
		}),
	));
