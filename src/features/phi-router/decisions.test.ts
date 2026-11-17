import { expect, test } from "bun:test";

import type { ClassifierContext, ClassifierResult, ImageContent } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decisionsPieceJudge, type Classify } from "./decisions.ts";
import { pieceOf } from "./policy/engine.fixture.ts";
import * as Engine from "./policy/engine.ts";

const resultOf = (fields: Pick<ClassifierResult, "answers" | "stopReason" | "errorMessage">): ClassifierResult => ({
	api: "openai-decisions",
	provider: "openai",
	model: "stub",
	timestamp: 0,
	...fields,
});

const run = (body: Effect.Effect<void>) => Effect.runPromise(body);

const billed = (input: number, cost: number): NonNullable<ClassifierResult["usage"]> => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

type Reply = Pick<ClassifierResult, "answers" | "stopReason" | "errorMessage" | "usage">;

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
	Effect.provideService(
		Engine.verdictsFor([piece], () => false),
		Engine.Judge,
		decisionsPieceJudge(classify),
	);

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
		why: "judge-error" | "judge-refused" | "judge-timeout",
		replies: Parameters<typeof replying>[0],
	]
> = [
	["a refusal", "judge-refused", { identifier: refused, kind: named("none") }],
	[
		"a timeout",
		"judge-timeout",
		{
			identifier: { answers: {}, stopReason: "error", errorMessage: "Request timed out after 20000ms" },
			kind: named("none"),
		},
	],
	["a probability above 1", "judge-error", { identifier: scored(1.5), kind: named("none") }],
	["a probability below 0", "judge-error", { identifier: scored(-1), kind: named("none") }],
	["a missing answer", "judge-error", { identifier: { answers: {}, stopReason: "stop" }, kind: named("none") }],
	["a kind outside the policy", "judge-error", { identifier: scored(0.3), kind: named("ssn-ish") }],
];

test.each(failures)("%s seals the piece as %s", (_name, why, replies) =>
	run(
		Effect.gen(function* () {
			const { found } = yield* judgedOn(replying(replies).classify);

			expect(Arr.map(found, ([, verdict]) => verdict)).toEqual([
				Engine.Verdict.Sealed({ finding: Engine.Finding.Failure({ why }) }),
			]);
		}),
	),
);

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
