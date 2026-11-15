import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { Judge } from "../policy/index.ts";
import { evaluate } from "./evaluate.ts";
import { defaultSeed, generate } from "./generate.ts";
import { recordedJudge, recordingsPath } from "./recorded.ts";

test(
	"the engine misses no PHI in the default corpus, on recorded Decisions answers alone",
	() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const recordings = yield* fs.readFileString(recordingsPath);
				const replay = yield* recordedJudge(recordings);
				const report = yield* evaluate(generate(defaultSeed)).pipe(Effect.provideService(Judge, replay.judge));

				const unrecorded = yield* replay.unrecorded;

				expect(report.misses).toEqual([]);
				expect(unrecorded).toBe(0);
			}).pipe(Effect.provide(NodeServices.layer)),
		),
	60_000,
);
