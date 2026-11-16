import { expect, test } from "bun:test";

import type { ClassifierContext, ClassifierResult, ImageContent } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { decisionsJudge, decisionsPieceJudge, type Classify } from "./decisions.ts";
import { pieceOf } from "./policy/engine.fixture.ts";
import * as Engine from "./policy/engine.ts";
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

const billed = (input: number, cost: number): NonNullable<ClassifierResult["usage"]> => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

type Reply = Pick<ClassifierResult, "answers" | "stopReason" | "errorMessage" | "usage">;

/** Decisions as a script: one reply per question name, and every context it was sent. */
const replying = (replies: Readonly<Record<"identifier" | "kind", Reply>>) => {
	const sent: Array<ClassifierContext> = [];

	const classify: Classify = (context) => {
		sent.push(context);

		const reply = "kind" in context.questions ? replies.kind : replies.identifier;

		return Promise.resolve(resultOf(reply));
	};

	return { classify, sent };
};

const scored = (probability: number, usage = billed(100, 0.5)): Reply => ({
	answers: { identifier: { type: "bool", probability } },
	stopReason: "stop",
	usage,
});

const named = (choice: string, usage = billed(40, 0.25)): Reply => ({
	answers: { kind: { type: "choice", choice, probabilities: {}, confidence: 1 } },
	stopReason: "stop",
	usage,
});

const judgedOn = (classify: Classify, piece = pieceOf("Note from the intake desk")) =>
	Effect.gen(function* () {
		const layer = decisionsPieceJudge(classify);
		const judge = yield* layer.pipe(Layer.build, Effect.map(Context.get(Engine.Judge)), Effect.scoped);

		return yield* Effect.provideService(
			Engine.verdictsFor([piece], () => false),
			Engine.Judge,
			judge,
		);
	});

test("a piece's images reach Decisions beside its text, and usage sums what each call billed", () =>
	run(
		Effect.gen(function* () {
			const images = [
				{ mimeType: "image/png", data: "aW1hZ2Ut" },
				{ mimeType: "image/jpeg", data: "c2Vjb25k" },
			];

			const { classify, sent } = replying({ identifier: scored(0.3), kind: named("none") });
			const { found, usage } = yield* judgedOn(classify, { ...pieceOf("Scanned referral"), images });

			const asSent: Array<ImageContent> = [
				{ type: "image", mimeType: "image/png", data: "aW1hZ2Ut" },
				{ type: "image", mimeType: "image/jpeg", data: "c2Vjb25k" },
			];

			expect(Arr.map(found, ([, verdict]) => verdict)).toEqual([Engine.Verdict.Cleared({ by: "judge" })]);
			expect(Arr.map(sent, ({ state, images: sentImages }) => ({ state, images: sentImages }))).toEqual(
				Arr.replicate(
					{
						state: { piece: "Scanned referral", context: [] },
						images: asSent,
					},
					2,
				),
			);
			expect([usage.calls, usage.inputTokens, usage.cost]).toEqual([2, 140, 0.75]);
		}),
	));

const refused: Reply = {
	answers: {},
	stopReason: "error",
	errorMessage: "OpenAI Decisions refused to answer identifier",
	usage: billed(100, 0.5),
};

const failures: ReadonlyArray<
	readonly [
		name: string,
		replies: Parameters<typeof replying>[0],
		why: "judge-error" | "judge-refused" | "judge-timeout",
	]
> = [
	["a refusal", { identifier: refused, kind: named("none") }, "judge-refused"],
	[
		"a timeout",
		{
			identifier: { answers: {}, stopReason: "error", errorMessage: "Request timed out after 20000ms" },
			kind: named("none"),
		},
		"judge-timeout",
	],
	["a probability above 1", { identifier: scored(1.5), kind: named("none") }, "judge-error"],
	["a missing answer", { identifier: { answers: {}, stopReason: "stop" }, kind: named("none") }, "judge-error"],
	["a kind outside the policy", { identifier: scored(0.3), kind: named("ssn-ish") }, "judge-error"],
];

for (const [name, replies, why] of failures) {
	test(`${name} seals the piece as ${why}`, () =>
		run(
			Effect.gen(function* () {
				const { found } = yield* judgedOn(replying(replies).classify);

				expect(Arr.map(found, ([, verdict]) => verdict)).toEqual([
					Engine.Verdict.Sealed({ finding: Engine.Finding.Failure({ why }) }),
				]);
			}),
		));
}

test("a refused call still counts what Decisions billed for it", () =>
	run(
		Effect.gen(function* () {
			const { usage } = yield* judgedOn(replying({ identifier: refused, kind: named("none") }).classify);

			expect([usage.calls, usage.inputTokens, usage.cost]).toEqual([1, 100, 0.5]);
		}),
	));

test("an aborted call interrupts the judging instead of sealing the piece", () =>
	run(
		Effect.gen(function* () {
			const aborted: Reply = { answers: {}, stopReason: "aborted", errorMessage: "Request was aborted" };
			const exit = yield* judgedOn(replying({ identifier: aborted, kind: aborted }).classify).pipe(Effect.exit);

			expect(exit.pipe(Exit.hasInterrupts)).toBe(true);
		}),
	));
