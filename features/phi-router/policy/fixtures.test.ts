import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { Fixtures, sha256 } from "./digest.ts";
import { Phi, ScanResult, type JudgeInput } from "./index.ts";
import { scanWith, user } from "./judge.fixture.ts";

const chart = "Patient: John Doe  MRN: 4417229, admitted with diabetic ketoacidosis";

const note = "Marisol Quintero was seen today for her HIV follow-up";

const tainting =
	(marker: string) =>
	({ seen, fresh }: JudgeInput) =>
		Effect.succeed({ pPhi: Str.includes(marker)(`${seen}${fresh}`) ? 0.9 : 0, category: Option.none() });

const registering = (texts: ReadonlyArray<string>) =>
	Effect.map(Effect.forEach(texts, sha256), (digests) => new Set(digests));

test("a registered part is skipped by both the rules and the judge", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fixtures = yield* registering([chart]);

			const { result, asked } = yield* Effect.provideService(
				scanWith({
					transcript: [user("Why does the import drop rows?"), user(chart)],
					answer: tainting("4417229"),
				}),
				Fixtures,
				fixtures,
			);

			expect(ScanResult.$is("Clean")(result)).toBe(true);
			expect(asked).toEqual([{ seen: "", fresh: "[user] Why does the import drop rows?\n[user] " }]);
		}),
	));

test("the same text with one character changed is judged", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fixtures = yield* registering([note]);

			const { result } = yield* Effect.provideService(
				scanWith({ transcript: [user(`${note}.`)], answer: tainting("Quintero") }),
				Fixtures,
				fixtures,
			);

			expect(ScanResult.$is("Tainted")(result) && result.taint).toEqual(Phi.make({ detector: "judge" }));
		}),
	));

test("a missing or empty registry exempts nothing", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const scanned = scanWith({ transcript: [user(chart)] });
			const missing = yield* scanned;
			const empty = yield* Effect.provideService(scanned, Fixtures, new Set());
			const taint = Phi.make({ detector: "rule", rule: "labelled-mrn", category: "mrn" });

			for (const { result } of [missing, empty]) {
				expect(ScanResult.$is("Tainted")(result) && result.taint).toEqual(taint);
			}
		}),
	));
