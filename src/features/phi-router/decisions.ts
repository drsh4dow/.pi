import type { ClassifierContext, ClassifierResult, ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { type Image, Judge, JudgeFailed, type JudgeInput, type Usage } from "./policy/engine.ts";
import { identifierQuestion, judgeLimits, judgeModel, kindQuestion, type IdentifierKind } from "./policy/policy.ts";

/** `signal` aborts the call when the asking fiber is interrupted. */
export type Classify = (
	context: ClassifierContext,
	options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<ClassifierResult>;

export { judgeModel as decisionsModel } from "./policy/policy.ts";

/** The Decisions parser in pi rejects non-finite numbers but passes any finite one, such as -1, which would read as clean. */
const isProbability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

/** A refusal and pi-ai's own request timeout both arrive as an error result, told apart only by its message. */
const failureOf = (message: string | undefined): JudgeFailed["why"] => {
	if (message === undefined) {
		return "judge-error";
	}

	if (Str.includes("refused to answer")(message)) {
		return "judge-refused";
	}

	return Str.includes("timed out")(message) ? "judge-timeout" : "judge-error";
};

/** Decisions bills a call even when it refuses or answers badly, so every outcome carries its usage. */
const usageOf = (result: ClassifierResult, ms: number): Usage => ({
	calls: 1,
	inputTokens: result.usage?.input ?? 0,
	cost: result.usage?.cost.total ?? 0,
	ms,
});

const imageOf = ({ mimeType, data }: Image): ImageContent => ({ type: "image", mimeType, data });

/**
 * One Decisions call on a piece. `aborted` comes only from an aborted signal, which means the request or the asking
 * fiber was cancelled, so it interrupts rather than sealing the piece as a failure.
 */
const answersTo = (classify: Classify, asked: ClassifierContext["questions"]) =>
	Effect.fn("answersTo")(function* (input: JudgeInput) {
		const context: ClassifierContext = {
			state: { piece: input.piece, context: input.context },
			images: Arr.map(input.images, imageOf),
			questions: asked,
		};

		const [elapsed, result] = yield* Effect.tryPromise({
			try: (signal) => classify(context, { timeoutMs: judgeLimits.timeoutMs, signal }),
			catch: () => JudgeFailed.make({ why: "judge-error" }),
		}).pipe(Effect.timed);

		const usage = usageOf(result, Duration.toMillis(elapsed));

		switch (result.stopReason) {
			case "stop": {
				return { answers: result.answers, usage };
			}

			case "aborted": {
				return yield* Effect.interrupt;
			}

			case "error": {
				return yield* JudgeFailed.make({ why: failureOf(result.errorMessage), usage });
			}

			default: {
				const unhandled: never = result.stopReason;

				return unhandled;
			}
		}
	});

const kindChoices: Readonly<Record<string, string>> = kindQuestion.criteria;

export const isKindAnswer = (choice: string): choice is IdentifierKind | "none" => Rec.has(kindChoices, choice);

/**
 * The engine's `Judge` over OpenAI Decisions. Each question is asked alone, because Decisions refuses a request whole
 * when it refuses any one question in it. A missing or out-of-range answer is a `judge-error`.
 */
export const decisionsPieceJudge = (classify: Classify) => {
	const identifierAnswers = answersTo(classify, { identifier: identifierQuestion });
	const kindAnswers = answersTo(classify, { kind: kindQuestion });

	return Judge.of({
		identifier: Effect.fn("identifier")(function* (input: JudgeInput) {
			const { answers, usage } = yield* identifierAnswers(input);
			const answer = answers["identifier"];

			if (answer?.type !== "bool" || !isProbability(answer.probability)) {
				return yield* JudgeFailed.make({ why: "judge-error", usage });
			}

			return { score: answer.probability, usage };
		}),
		kind: Effect.fn("kind")(function* (input: JudgeInput) {
			const { answers, usage } = yield* kindAnswers(input);
			const answer = answers["kind"];

			if (answer?.type !== "choice" || !isKindAnswer(answer.choice)) {
				return yield* JudgeFailed.make({ why: "judge-error", usage });
			}

			return { kind: answer.choice, usage };
		}),
	});
};

/** The Decisions judge on the registry's classifier. */
export const decisionsOf = ({ modelRegistry, signal }: Pick<ExtensionContext, "modelRegistry" | "signal">) => {
	const classifier = Option.fromUndefinedOr(modelRegistry.findOfType("classifier", "openai", judgeModel));

	const classify: Classify = (context, options) =>
		Option.match(classifier, {
			onNone: () => Promise.reject(new Error(`no classifier openai/${judgeModel}`)),
			onSome: (model) =>
				modelRegistry.classify(model, context, {
					...options,
					signal: AbortSignal.any(Arr.filter([options.signal, signal], Predicate.isNotUndefined)),
				}),
		});

	return decisionsPieceJudge(classify);
};
