import { expect } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { VerdictRecord, verdictsFolder } from "../pr/index.ts";
import { sessionRoot } from "./world.fixture.ts";

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(VerdictRecord));

interface Expected {
	readonly pr: number;
	readonly expected: ReadonlyArray<object>;
}

/** Every verdict record of the pull request `o/r#<pr>`, read the way a merge gate would, in path order. */
export const recordsAre =
	(fs: FileSystem.FileSystem) =>
	({ pr, expected }: Expected) => {
		const folder = `${verdictsFolder(sessionRoot)}/o/r/${String(pr)}`;
		const read = (file: string) => Effect.flatMap(fs.readFileString(`${folder}/${file}`), decodeRecord);

		return Effect.orElseSucceed(fs.readDirectory(folder, { recursive: true }), Arr.empty<string>).pipe(
			Effect.map((files) => Arr.filter(Arr.sort(files, Order.String), Str.endsWith(".json"))),
			Effect.flatMap(Effect.forEach(read)),
			Effect.orDie,
			Effect.flatMap((records) =>
				Effect.sync(() => {
					expect<ReadonlyArray<object>>(records).toEqual(expected);
				}),
			),
		);
	};
