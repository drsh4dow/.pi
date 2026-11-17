import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { Judge } from "#src/features/phi-router/policy/engine.ts";
import { stubs } from "#src/features/phi-router/policy/policy.ts";
import { evaluate, play } from "./evaluate.ts";
import type { Case, Synthetic } from "./manifest.ts";
import { missRateUpperBound } from "./report.ts";

test("the leak-rate bound is the exact one-sided Clopper-Pearson 95% upper limit", () => {
	expect(missRateUpperBound({ misses: 0, cases: 20 })).toBeCloseTo(0.1391, 4);
	expect(missRateUpperBound({ misses: 0, cases: 100 })).toBeCloseTo(0.0295, 4);
	expect(missRateUpperBound({ misses: 1, cases: 20 })).toBeCloseTo(0.2161, 4);
	expect(missRateUpperBound({ misses: 5, cases: 5 })).toBe(1);
});

const usage = { calls: 1, inputTokens: 10, cost: 0.001, ms: 0 };

const noSynthetic = { exact: [], prefixes: [] };

const judge = Judge.of({
	identifier: ({ piece }) => Effect.succeed({ score: Str.includes("SEAL")(piece) ? 0.9 : 0, usage }),
	kind: () => Effect.succeed({ kind: "ssn", usage }),
});

const strata = { identifier: "ssn", carrier: "log-line", transform: "plain", entry: "tool-result" } as const;

const readRecord = (id: string, record: string): Case => ({
	id,
	expect: "phi",
	strata,
	canaries: [`canary-${id}`],
	fragments: [],
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
	fragments: [],
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

			const shown = Arr.map(sent, ({ lane, view }) => ({
				lane,
				canary: Option.exists(view, Str.includes("canary-sealed")),
				stub: Option.exists(view, Str.includes(stubs.sealed)),
			}));

			expect(shown).toEqual([
				{ lane: "personal", canary: false, stub: false },
				{ lane: "ent", canary: false, stub: false },
				{ lane: "personal", canary: false, stub: true },
			]);
		}),
	));

test("a canary the judge clears is a leak at the request that first shows it, and a clean case stays personal", () =>
	run(
		Effect.gen(function* () {
			const report = yield* evaluate({
				cases: [sealed, missed, clean],
				synthetic: noSynthetic,
				window: 1,
			});

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

const splitAcross = (id: string, second: string): Case => ({
	id,
	expect: "phi",
	strata: { ...strata, transform: "split", entry: "user" },
	canaries: [`canary-${id}-tail`],
	canaryParts: { [`canary-${id}-tail`]: [`canary-${id}`, "-tail"] },
	fragments: [],
	messages: [
		{ role: "user", text: `The id starts canary-${id}` },
		{ role: "assistant", text: "Go on." },
		{ role: "user", text: `${second} and it ends -tail` },
	],
});

test("a split canary whose parts reached personal accounts in two messages is reported apart and is no leak", () =>
	run(
		Effect.gen(function* () {
			const report = yield* evaluate({
				cases: [splitAcross("apart", "Then"), splitAcross("cut", "SEAL")],
				synthetic: noSynthetic,
				window: 1,
			});

			expect(report.leaks).toEqual([]);
			expect(Arr.map(report.splits, ({ id, request }) => ({ id, request }))).toEqual([{ id: "apart", request: 2 }]);
			expect(report.fragments).toEqual({ cases: 1, shown: 1 });
		}),
	));

test("a split canary that one message shows whole is a leak, not a split", () =>
	run(
		Effect.gen(function* () {
			const cut = splitAcross("joined", "Then");
			const joined: Case = { ...cut, messages: [...cut.messages, { role: "user", text: "So canary-joined-tail." }] };
			const report = yield* evaluate({ cases: [joined], synthetic: noSynthetic, window: 1 });

			expect(Arr.map(report.leaks, ({ id }) => id)).toEqual(["joined"]);
			expect(report.splits).toEqual([]);
		}),
	));

test("a planted fragment on a personal account is reported, never a leak", () =>
	run(
		Effect.gen(function* () {
			const fragment: Case = { ...clean, strata: { negative: "fragment" }, fragments: ["512-83"] };
			const withFragment: Case = { ...fragment, messages: [{ role: "user", text: "The SSN starts 512-83, why?" }] };
			const report = yield* evaluate({ cases: [withFragment], synthetic: noSynthetic, window: 1 });

			expect(report.leaks).toEqual([]);
			expect(report.fragments).toEqual({ cases: 1, shown: 1 });
		}),
	));

test("the corpus's exact test identities reach the engine, so a case holding only them stays personal", () =>
	run(
		Effect.gen(function* () {
			const listed: Case = {
				...clean,
				strata: { negative: "synthetic-listed" },
				messages: [{ role: "user", text: "Eligibility times out for member SEAL-QA-17." }],
			};

			const played = (synthetic: Synthetic) =>
				Effect.map(evaluate({ cases: [listed], synthetic, window: 1 }), ({ lanes }) => lanes);

			const exact = yield* played({ exact: ["SEAL-QA-17"], prefixes: [] });
			const prefixed = yield* played({ exact: [], prefixes: ["SEAL-QA"] });
			const unlisted = yield* played(noSynthetic);

			expect([exact, prefixed, unlisted]).toEqual([
				{ personal: 1, ent: 0 },
				{ personal: 1, ent: 0 },
				{ personal: 0, ent: 1 },
			]);
		}),
	));
