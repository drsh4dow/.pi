import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";

import { Judge } from "../policy/engine.ts";
import { evaluate, play } from "./evaluate.ts";
import type { Case } from "./manifest.ts";
import { missRateUpperBound } from "./report.ts";

test("the leak-rate bound is the exact one-sided Clopper-Pearson 95% upper limit", () => {
	expect(missRateUpperBound({ misses: 0, cases: 20 })).toBeCloseTo(0.1391, 4);
	expect(missRateUpperBound({ misses: 0, cases: 100 })).toBeCloseTo(0.0295, 4);
	expect(missRateUpperBound({ misses: 1, cases: 20 })).toBeCloseTo(0.2161, 4);
	expect(missRateUpperBound({ misses: 5, cases: 5 })).toBe(1);
});

const usage = { calls: 1, inputTokens: 10, cost: 0.001, ms: 0 };

/** Seals exactly the pieces that hold `SEAL`. */
const judge = Judge.of({
	identifier: ({ piece }) => Effect.succeed({ score: Str.includes("SEAL")(piece) ? 0.9 : 0, usage }),
	kind: () => Effect.succeed({ kind: "ssn", usage }),
});

const strata = { identifier: "ssn", carrier: "log-line", transform: "plain", entry: "tool-result" } as const;

/** A prompt, a tool result holding `record`, and a second prompt after the reply. */
const readRecord = (id: string, record: string): Case => ({
	id,
	expect: "phi",
	strata,
	canaries: [`canary-${id}`],
	messages: [
		{ role: "user", text: "Why does the import drop this row?" },
		{ role: "assistant", text: "Reading the log." },
		{ role: "tool", text: `${record} canary-${id}` },
		{ role: "assistant", text: "The row has no member id." },
		{ role: "user", text: "Now add a test for it." },
	],
});

const sealed = readRecord("sealed", "SEAL row 88");

const missed = readRecord("missed", "row 88");

const clean: Case = {
	id: "clean",
	expect: "clean",
	strata: { negative: "schema-only" },
	canaries: [],
	messages: [
		{ role: "user", text: "Add a nullable dob column to patients." },
		{ role: "assistant", text: "Done." },
		{ role: "user", text: "Now index it." },
	],
};

const run = (body: Effect.Effect<void, never, Judge>) => Effect.runPromise(Effect.provideService(body, Judge, judge));

test("a sealed tool result goes to ent, and play returns to personal without its canary in the guarded view", () =>
	run(
		Effect.gen(function* () {
			const { sent } = yield* play({ subject: sealed, window: 1 });

			expect(Arr.map(sent, ({ lane, leaked }) => ({ lane, leaked }))).toEqual([
				{ lane: "personal", leaked: [] },
				{ lane: "ent", leaked: [] },
				{ lane: "personal", leaked: [] },
			]);
		}),
	));

test("a canary the judge clears is a leak at the request that first shows it, and a clean case stays personal", () =>
	run(
		Effect.gen(function* () {
			const report = yield* evaluate({ cases: [sealed, missed, clean], window: 1 });

			expect(report.leaks).toEqual([{ id: "missed", strata, request: 2 }]);
			expect(report.overRouting).toContainEqual({
				negative: "schema-only",
				cases: 1,
				overRouted: 0,
				requests: 2,
				onEnt: 0,
			});
			expect(report.lanes).toEqual({ personal: 7, ent: 1 });
		}),
	));
