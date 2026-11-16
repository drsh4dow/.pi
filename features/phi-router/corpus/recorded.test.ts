import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";

import { Judge, JudgeFailed } from "../policy/engine.ts";
import { recordedJudge, recording } from "./recorded.ts";

const usage = { calls: 1, inputTokens: 120, cost: 0.002, ms: 300 };

const live = Judge.of({
	identifier: () => Effect.succeed({ score: 0.31, usage }),
	kind: () => Effect.succeed({ kind: "patient-name", usage }),
});

const asked = { piece: "patient Jane Roe", context: ["[user] why is this row rejected?"], images: [] };

const replay = Effect.gen(function* () {
	const recorder = recording(live);

	yield* recorder.judge.identifier(asked);
	yield* recorder.judge.kind(asked);

	const contents = yield* recorder.contents;

	return yield* recordedJudge(contents);
});

test("a recorded call replays its answer and what it cost", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const replayed = yield* replay;
			const identifier = yield* replayed.judge.identifier(asked);
			const kind = yield* replayed.judge.kind(asked);
			const unrecorded = yield* replayed.unrecorded;

			expect(identifier).toEqual({ score: 0.31, usage: { ...usage, ms: 0 } });
			expect(kind).toEqual({ kind: "patient-name", usage: { ...usage, ms: 0 } });
			expect(unrecorded).toBe(0);
		}),
	));

test("a call the file lacks, even one differing only in its context, fails and counts as unrecorded", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const replayed = yield* replay;
			const failure = yield* Effect.flip(replayed.judge.identifier({ ...asked, context: [] }));

			const unrecorded = yield* replayed.unrecorded;

			expect(failure).toBeInstanceOf(JudgeFailed);
			expect(unrecorded).toBe(1);
		}),
	));
