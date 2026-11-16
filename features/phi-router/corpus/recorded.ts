import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { isKindAnswer } from "../decisions.ts";
import { sha256 } from "../policy/digest.ts";
import { Judge, JudgeFailed, type JudgeInput, type Usage } from "../policy/engine.ts";
import { policyVersion } from "../policy/policy.ts";
import { decodeJsonLines } from "./jsonl.ts";

export const recordingsPath = `${import.meta.dirname}/recordings.jsonl`;

const Question = Schema.Literals(["identifier", "kind"]);

type Question = typeof Question.Type;

const KindAnswer = Schema.String.pipe(Schema.refine(isKindAnswer));

const Answer = Schema.Union([
	Schema.Struct({ score: Schema.Finite }),
	Schema.Struct({ kind: KindAnswer }),
	Schema.Struct({ refused: Schema.Literal(true) }),
]);

type Answer = typeof Answer.Type;

/** One judge call: what it was asked, as digests, and what it answered and cost. */
const Recording = Schema.Struct({
	policy: Schema.String,
	question: Question,
	piece: Schema.String,
	context: Schema.String,
	images: Schema.Array(Schema.String),
	answer: Answer,
	inputTokens: Schema.Finite,
	cost: Schema.Finite,
});

type Recording = typeof Recording.Type;

const RecordingLine = Schema.fromJsonString(Recording);

const lengthPrefixed = (fields: ReadonlyArray<string>) =>
	Arr.join(
		Arr.map(fields, (field) => `${String(field.length)}:${field}`),
		"",
	);

const digestOf = (fields: ReadonlyArray<string>) => Str.slice(0, 32)(sha256(lengthPrefixed(fields)));

/** The policy version, the question, and digests of the piece, of its context items and of each image. */
const askedOf = (question: Question, input: JudgeInput) => ({
	policy: Str.slice(0, 32)(policyVersion),
	question,
	piece: digestOf([input.piece]),
	context: digestOf(input.context),
	images: Arr.map(input.images, ({ mimeType, data }) => digestOf([mimeType, data])),
});

const keyOf = ({ policy, question, piece, context, images }: Omit<Recording, "answer" | "inputTokens" | "cost">) =>
	Arr.join([policy, question, piece, context, ...images], " ");

const usageOf = ({ inputTokens, cost }: Recording): Usage => ({ calls: 1, inputTokens, cost, ms: 0 });

/**
 * A judge that answers only from `contents`, a recordings file. A call it has no answer for, including every call
 * recorded under another policy version, fails as a judge error and counts in `unrecorded`.
 */
export const recordedJudge = Effect.fn("recordedJudge")(function* (contents: string) {
	const recordings = yield* decodeJsonLines({ schema: RecordingLine, source: "recordings.jsonl", text: contents });
	const answers = new Map(Arr.map(recordings, (recording) => [keyOf(recording), recording] as const));
	const unrecorded = yield* Ref.make(0);

	const recorded = (question: Question, input: JudgeInput) => {
		const found = answers.get(keyOf(askedOf(question, input)));

		if (found === undefined) {
			return Effect.andThen(
				Ref.update(unrecorded, (count) => count + 1),
				Effect.fail(JudgeFailed.make({ why: "judge-error" })),
			);
		}

		return "refused" in found.answer
			? Effect.fail(JudgeFailed.make({ why: "judge-refused", usage: usageOf(found) }))
			: Effect.succeed({ answer: found.answer, usage: usageOf(found) });
	};

	const judge = Judge.of({
		identifier: (input) =>
			Effect.flatMap(recorded("identifier", input), ({ answer, usage }) =>
				"score" in answer
					? Effect.succeed({ score: answer.score, usage })
					: Effect.fail(JudgeFailed.make({ why: "judge-error" })),
			),
		kind: (input) =>
			Effect.flatMap(recorded("kind", input), ({ answer, usage }) =>
				"kind" in answer
					? Effect.succeed({ kind: answer.kind, usage })
					: Effect.fail(JudgeFailed.make({ why: "judge-error" })),
			),
	});

	return { judge, unrecorded: Ref.get(unrecorded) };
});

/** `live`, keeping every answer and refusal, and `contents`: them as a recordings file, one line per call, sorted. */
export const recording = (live: Judge["Service"]) => {
	const kept = new Map<string, Recording>();

	const remember = (question: Question, input: JudgeInput, answer: Answer, usage: Usage) => {
		const asked = askedOf(question, input);

		kept.set(keyOf(asked), { ...asked, answer, inputTokens: usage.inputTokens, cost: usage.cost });
	};

	const remembered = <Value extends { readonly usage: Usage }>(
		question: Question,
		input: JudgeInput,
		call: Effect.Effect<Value, JudgeFailed>,
		answerOf: (value: Value) => Answer,
	) =>
		call.pipe(
			Effect.tap((value) =>
				Effect.sync(() => {
					remember(question, input, answerOf(value), value.usage);
				}),
			),
			Effect.tapError((failed) =>
				Effect.sync(() => {
					if (failed.why === "judge-refused" && failed.usage !== undefined) {
						remember(question, input, { refused: true }, failed.usage);
					}
				}),
			),
		);

	const judge = Judge.of({
		identifier: (input) => remembered("identifier", input, live.identifier(input), ({ score }) => ({ score })),
		kind: (input) => remembered("kind", input, live.kind(input), ({ kind }) => ({ kind })),
	});

	const contents = Effect.gen(function* () {
		const sorted = Arr.sortWith(Arr.fromIterable(kept), ([key]) => key, Order.String);
		const lines = yield* Effect.forEach(sorted, ([, line]) => Schema.encodeEffect(RecordingLine)(line));

		return Arr.join(
			Arr.map(lines, (line) => `${line}\n`),
			"",
		);
	});

	return { judge, contents };
};
