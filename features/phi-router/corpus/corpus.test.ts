import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { Judge } from "../policy/engine.ts";
import { window } from "../policy/policy.ts";
import { evaluate } from "./evaluate.ts";
import { defaultSeed, generate } from "./generate.ts";
import { loadImages } from "./images.ts";
import { recordedJudge, recordingsPath } from "./recorded.ts";
import { synthetic } from "./synthetic.ts";

const played = await Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const contents = yield* fs.readFileString(recordingsPath);
	const replay = yield* recordedJudge(contents);

	const images = yield* loadImages;
	const cases = generate({ seed: defaultSeed, images });

	const report = yield* evaluate({ cases, synthetic, window }).pipe(Effect.provideService(Judge, replay.judge));

	return { report, unrecorded: yield* replay.unrecorded };
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

test("the recorded Decisions answers cover every judge call of the default corpus", () => {
	expect(played.unrecorded).toBe(0);
});

test("no in-policy PHI in the default corpus reaches a personal account", () => {
	expect(played.report.leaks).toEqual([]);
});
