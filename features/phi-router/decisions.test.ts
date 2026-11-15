import { expect, test } from "bun:test";

import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { decisionsJudge, type Classify } from "./decisions.ts";
import { Judge, Phi, ScanResult, scan, Unscanned, type Transcript } from "./policy/index.ts";
import { system, user } from "./policy/judge.fixture.ts";

const resultOf = (fields: Pick<ClassifierResult, "answers" | "stopReason" | "errorMessage">): ClassifierResult => ({
	api: "openai-decisions",
	provider: "openai",
	model: "stub",
	timestamp: 0,
	...fields,
});

const answering =
	(probability: number): Classify =>
	(context: ClassifierContext) => {
		const bools = Arr.filter(Rec.keys(context.questions), (name) => name !== "category");
		const answers = Rec.fromEntries(Arr.map(bools, (name) => [name, { type: "bool", probability }] as const));

		return Promise.resolve(resultOf({ answers, stopReason: "stop" }));
	};

/**
 * Decisions as observed live on pi's system prompt: a request that holds the category question is refused whole, with
 * no answers, while the yes-or-no questions alone are answered.
 */
const decisions =
	({ probability, refusesCategory }: { readonly probability: number; readonly refusesCategory: boolean }) =>
	(asked: Array<string>): Classify =>
	(context: ClassifierContext) => {
		const names = Rec.keys(context.questions);

		asked.push(...names);

		if (!Arr.contains(names, "category")) {
			return answering(probability)(context, { timeoutMs: 0 });
		}

		if (refusesCategory) {
			return Promise.resolve(
				resultOf({ answers: {}, stopReason: "error", errorMessage: "OpenAI Decisions refused to answer category" }),
			);
		}

		return Promise.resolve(
			resultOf({
				answers: { category: { type: "choice", choice: "name", probabilities: {}, confidence: 1 } },
				stopReason: "stop",
			}),
		);
	};

const scanOn = (classify: Classify, transcript: Transcript = [user("Marisol Quintero has HIV")]) =>
	Effect.gen(function* () {
		const layer = decisionsJudge(classify);
		const judge = yield* layer.pipe(Layer.build, Effect.map(Context.get(Judge)), Effect.scoped);

		return yield* Effect.provideService(scan(transcript, Unscanned.make({})), Judge, judge);
	});

const piSystemPrompt = [system(Str.repeat(800)("You are Claude Code, Anthropic's official CLI for Claude.\n"))];

const taintOf = (result: ScanResult) => (ScanResult.$is("Tainted")(result) ? Option.some(result.taint) : Option.none());

const run = (body: Effect.Effect<void>) => Effect.runPromise(body);

for (const probability of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
	test(`a probability of ${String(probability)} is a judge error, never a verdict`, () =>
		run(
			Effect.gen(function* () {
				const result = yield* scanOn(answering(probability));

				expect(ScanResult.$is("Unsure")(result) && result.why).toBe("judge-error");
			}),
		));
}

test("a refused category question leaves a clean verdict clean, and a clean verdict never asks it", () =>
	run(
		Effect.gen(function* () {
			const asked: Array<string> = [];
			const result = yield* scanOn(decisions({ probability: 0, refusesCategory: true })(asked), piSystemPrompt);

			expect(result._tag).toBe("Clean");
			expect(asked).toEqual(["phi", "record", "patientData"]);
		}),
	));

test("a refused category question still taints, with no category", () =>
	run(
		Effect.gen(function* () {
			const result = yield* scanOn(decisions({ probability: 0.9, refusesCategory: true })([]), piSystemPrompt);

			expect(taintOf(result)).toEqual(Option.some(Phi.make({ detector: "judge" })));
		}),
	));

test("a tainting verdict carries the category Decisions names", () =>
	run(
		Effect.gen(function* () {
			const asked: Array<string> = [];
			const result = yield* scanOn(decisions({ probability: 0.9, refusesCategory: false })(asked), piSystemPrompt);

			expect(taintOf(result)).toEqual(Option.some(Phi.make({ detector: "judge", category: "name" })));
			expect(asked).toEqual(["phi", "record", "patientData", "category"]);
		}),
	));

const onlyPatientData: Classify = (context: ClassifierContext) => {
	if ("category" in context.questions) {
		return Promise.resolve(resultOf({ answers: {}, stopReason: "error" }));
	}

	return Promise.resolve(
		resultOf({
			answers: {
				phi: { type: "bool", probability: 0 },
				record: { type: "bool", probability: 0 },
				patientData: { type: "bool", probability: 0.9 },
			},
			stopReason: "stop",
		}),
	);
};

test("a patient-record value the other questions miss, such as a cut-off header, still taints", () =>
	run(
		Effect.gen(function* () {
			const result = yield* scanOn(onlyPatientData, [user("exports/2024-03/referrals/NG207")]);

			expect(taintOf(result)).toEqual(Option.some(Phi.make({ detector: "judge" })));
		}),
	));
