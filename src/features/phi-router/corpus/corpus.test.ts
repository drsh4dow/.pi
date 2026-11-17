import { beforeAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { Judge } from "#src/features/phi-router/policy/engine.ts";
import { window } from "#src/features/phi-router/policy/policy.ts";
import { evaluate } from "./evaluate.ts";
import { defaultSeed, generate } from "./generate.ts";
import { loadImages } from "./images.ts";
import { recordedJudge, recordingsPath } from "./recorded.ts";
import type { Report } from "./report.ts";
import { synthetic } from "./synthetic.ts";

interface Played {
	unrecorded: number;
	leaks: Report["leaks"];
}

const played: Played = { unrecorded: Number.NaN, leaks: [] };

beforeAll(
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const contents = yield* fs.readFileString(recordingsPath);
			const replay = yield* recordedJudge(contents);

			const images = yield* loadImages;
			const cases = generate({ seed: defaultSeed, images });

			const report = yield* evaluate({ cases, synthetic, window }).pipe(Effect.provideService(Judge, replay.judge));

			played.leaks = report.leaks;
			played.unrecorded = yield* replay.unrecorded;
		}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise),
	120_000,
);

test("the recorded Decisions answers cover every judge call of the default corpus", () => {
	expect(played.unrecorded).toBe(0);
});

test("no complete identifier in the default corpus reaches a personal account in one message", () => {
	expect(played.leaks).toEqual([]);
});
