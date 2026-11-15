import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { maxChars, questions } from "../decisions.ts";
import { sha256 } from "../policy/digest.ts";
import { Judge, type JudgeAnswer, JudgeFailed, type JudgeInput, SafeHarbor } from "../policy/index.ts";
import { decodeJsonLines } from "./jsonl.ts";

export const recordingsPath = `${import.meta.dirname}/recordings.jsonl`;

const Recording = Schema.Struct({ digest: Schema.String, pPhi: Schema.Finite, category: Schema.NullOr(SafeHarbor) });

const RecordingLine = Schema.fromJsonString(Recording);

const prompt = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(questions).pipe(Effect.orDie);

const digestOf = (input: JudgeInput) =>
	Effect.flatMap(prompt, (questionsJson) =>
		sha256(`${questionsJson.length}\n${questionsJson}${input.seen.length}\n${input.seen}${input.fresh}`),
	).pipe(Effect.map(Str.slice(0, 32)));

/**
 * A judge that answers only from `contents`, a recordings file. An input it has no answer for fails the call and
 * counts in `unrecorded`.
 */
export const recordedJudge = Effect.fn("recordedJudge")(function* (contents: string) {
	const recordings = yield* decodeJsonLines({ schema: RecordingLine, source: "recordings.jsonl", text: contents });
	const unrecorded = yield* Ref.make(0);

	const answers = new Map(
		Arr.map(recordings, ({ digest, pPhi, category }) => [digest, { pPhi, category: Option.fromNullOr(category) }]),
	);

	const failed = JudgeFailed.make({ why: "error" });
	const notRecorded = Ref.update(unrecorded, (count) => count + 1).pipe(Effect.andThen(Effect.fail(failed)));

	const ask = (input: JudgeInput) =>
		Effect.flatMap(digestOf(input), (digest) => {
			const answer = answers.get(digest);

			return answer === undefined ? notRecorded : Effect.succeed(answer);
		});

	return { judge: Judge.of({ maxChars, ask }), unrecorded: Ref.get(unrecorded) };
});

const lineOf = ([digest, { pPhi, category }]: readonly [string, JudgeAnswer]) =>
	Schema.encodeEffect(RecordingLine)({
		digest,
		pPhi: Math.round(pPhi * 10_000) / 10_000,
		category: Option.getOrNull(category),
	});

/** `live`, keeping every successful answer, and `contents`: those answers as a recordings file sorted by digest. */
export const recording = Effect.fn("recording")(function* (live: Judge["Service"]) {
	const answers = yield* Ref.make(HashMap.empty<string, JudgeAnswer>());

	const ask = (input: JudgeInput) =>
		Effect.tap(live.ask(input), (answer) =>
			Effect.flatMap(digestOf(input), (digest) => Ref.update(answers, HashMap.set(digest, answer))),
		);

	const contents = Ref.get(answers).pipe(
		Effect.map((recorded) => Arr.sortWith(Arr.fromIterable(recorded), ([digest]) => digest, Order.String)),
		Effect.flatMap((sorted) => Effect.forEach(sorted, lineOf)),
		Effect.map((lines) =>
			Arr.join(
				Arr.map(lines, (line) => `${line}\n`),
				"",
			),
		),
	);

	return { judge: Judge.of({ maxChars: live.maxChars, ask }), contents };
});
