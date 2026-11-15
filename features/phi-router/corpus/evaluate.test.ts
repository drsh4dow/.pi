import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Str from "effect/String";

import { Judge, JudgeFailed, type JudgeInput } from "../policy/index.ts";
import { evaluate, missRateUpperBound } from "./evaluate.ts";
import type { Case } from "./manifest.ts";

test("the miss-rate bound is the exact one-sided Clopper-Pearson 95% upper limit", () => {
	expect(missRateUpperBound({ misses: 0, cases: 20 })).toBeCloseTo(0.1391, 4);
	expect(missRateUpperBound({ misses: 0, cases: 100 })).toBeCloseTo(0.0295, 4);
	expect(missRateUpperBound({ misses: 1, cases: 20 })).toBeCloseTo(0.2161, 4);
	expect(missRateUpperBound({ misses: 5, cases: 5 })).toBe(1);
});

const phi = (id: string, identifier: "name" | "ssn", texts: readonly [string, ...Array<string>]): Case => ({
	id,
	expect: "phi",
	strata: { identifier, carrier: "csv", transform: "plain", entry: "user" },
	canaries: [`canary-${id}`],
	messages: Arr.map(texts, (text) => ({ role: "user", text })),
});

const clean = (id: string, negative: "schema-only" | "look-alike", text: string): Case => ({
	id,
	expect: "clean",
	strata: { negative },
	canaries: [],
	messages: [{ role: "user", text }],
});

const cases = [
	phi("missed", "ssn", ["alpha one", "alpha two"]),
	phi("exposed", "ssn", ["foxtrot canary-exposed", "foxtrot TAINT"]),
	phi("tainted", "name", ["bravo one", "bravo TAINT canary-tainted", "bravo three"]),
	phi("unsure", "name", ["charlie UNSURE canary-unsure"]),
	clean("over-routed", "look-alike", "delta TAINT"),
	clean("clean", "schema-only", "echo one"),
];

const stubJudge = (asked: Ref.Ref<ReadonlyArray<JudgeInput>>) =>
	Judge.of({
		maxChars: 1_000_000,
		ask: (input) => {
			const record = Ref.update(asked, Arr.append(input));

			if (Str.includes("UNSURE")(input.fresh)) {
				return Effect.andThen(record, Effect.fail(JudgeFailed.make({ why: "error" })));
			}

			const pPhi = Str.includes("TAINT")(input.fresh) ? 0.9 : 0;

			return Effect.as(record, { pPhi, category: Option.none() });
		},
	});

const evaluated = Effect.gen(function* () {
	const asked = yield* Ref.make<ReadonlyArray<JudgeInput>>([]);
	const report = yield* evaluate(cases).pipe(Effect.provideService(Judge, stubJudge(asked)));
	const inputs = yield* Ref.get(asked);

	return { report, inputs };
});

test("the evaluation counts a miss, a canary a Clean scan sent, a catch, an uncertain catch and an over-routed clean case", () =>
	Effect.runPromise(
		Effect.map(evaluated, ({ report }) => {
			const row = (value: string) => Arr.findFirst(report.strata, (stratum) => stratum.value === value);

			const counts = (value: string) =>
				Option.map(row(value), ({ cases: total, misses, uncertain }) => ({ total, misses, uncertain }));

			const strata = { identifier: "ssn", carrier: "csv", transform: "plain", entry: "user" } as const;

			expect(report.misses).toEqual([
				{ id: "missed", strata },
				{ id: "exposed", strata },
			]);
			expect(report.totals).toEqual({ phi: 4, misses: 2, uncertain: 1, clean: 2, overRouted: 1 });
			expect(Option.map(row("ssn"), ({ missRateUpper95 }) => missRateUpper95)).toEqual(Option.some(1));
			expect(Arr.map(["ssn", "name", "csv", "fax"], counts)).toEqual([
				Option.some({ total: 2, misses: 2, uncertain: 0 }),
				Option.some({ total: 2, misses: 0, uncertain: 1 }),
				Option.some({ total: 4, misses: 2, uncertain: 1 }),
				Option.some({ total: 0, misses: 0, uncertain: 0 }),
			]);
			expect(report.overRouting).toContainEqual({ negative: "look-alike", cases: 1, overRouted: 1 });
			expect(report.overRouting).toContainEqual({ negative: "schema-only", cases: 1, overRouted: 0 });
		}),
	));

test("the evaluation scans every step of an uncaught case, none past a catch, and times every judge call", () =>
	Effect.runPromise(
		Effect.map(evaluated, ({ report, inputs }) => {
			const saw = (text: string) => Arr.some(inputs, (input) => Str.includes(text)(input.seen + input.fresh));

			expect(saw("alpha two")).toBe(true);
			expect(saw("bravo three")).toBe(false);
			expect(report.judge.calls).toBe(inputs.length);
		}),
	));
