import { expect } from "bun:test";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { verdictsFolder, verdictsOf } from "../pr/index.ts";
import { sessionRoot } from "./world.fixture.ts";

interface Expected {
	readonly pr: number;
	readonly expected: ReadonlyArray<object>;
}

export const recordsAre =
	(fs: FileSystem.FileSystem) =>
	({ pr, expected }: Expected) =>
		verdictsOf(verdictsFolder(sessionRoot))({ repo: "o/r", number: pr }).pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.flatMap((records) =>
				Effect.sync(() => {
					expect<ReadonlyArray<object>>(records).toEqual(expected);
				}),
			),
		);
