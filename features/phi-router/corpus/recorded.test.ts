import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Judge, JudgeFailed } from "../policy/index.ts";
import { recordedJudge, recording } from "./recorded.ts";

const live = Judge.of({
	maxChars: 100,
	ask: () => Effect.succeed({ pPhi: 0.91236, category: Option.some("name" as const) }),
});

const recorded = { seen: "visit on 2031-04-02", fresh: "patient Jane Roe" };

const replay = Effect.gen(function* () {
	const recorder = yield* recording(live);

	yield* recorder.judge.ask(recorded);

	const contents = yield* recorder.contents;

	const replayed = yield* recordedJudge(contents);

	return { contents, replayed };
});

test("a recorded call replays its answer, rounded to 4 decimals, from one sorted line of the file", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { contents, replayed } = yield* replay;

			expect(contents).toMatch(/^\{"digest":"[0-9a-f]{32}","pPhi":0\.9124,"category":"name"\}\n$/u);
			const answer = yield* replayed.judge.ask(recorded);
			const unrecorded = yield* replayed.unrecorded;

			expect(answer).toEqual({ pPhi: 0.9124, category: Option.some("name") });
			expect(unrecorded).toBe(0);
		}),
	));

test("an input the file lacks, even one differing only in seen, fails and counts as unrecorded", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { replayed } = yield* replay;
			const failure = yield* Effect.flip(replayed.judge.ask({ ...recorded, seen: "" }));
			const unrecorded = yield* replayed.unrecorded;

			expect(failure).toBeInstanceOf(JudgeFailed);
			expect(unrecorded).toBe(1);
		}),
	));
