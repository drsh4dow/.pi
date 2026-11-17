import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";

import { spendSince } from "./index.ts";

const scratch = await Effect.runPromise(
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectory()).pipe(Effect.provide(NodeServices.layer)),
);

afterAll(() =>
	Effect.runPromise(
		Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(scratch, { recursive: true })).pipe(
			Effect.provide(NodeServices.layer),
		),
	),
);

const since = DateTime.makeUnsafe("2026-10-11T12:00:00Z");

const at = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

interface Reply {
	readonly provider: string;
	readonly timestamp: number;
	readonly cost: number;
}

/** One line as pi writes an assistant reply, with the fields that do not matter here cut. */
const replyLine = ({ provider, timestamp, cost }: Reply) =>
	`{"type":"message","id":"a1","message":{"role":"assistant","provider":"${provider}","model":"m","timestamp":${timestamp},"usage":{"cost":{"total":${cost}}}}}`;

/** A sessions folder holding the given files, each a list of lines. */
const sessionsWith = (name: string, files: Readonly<Record<string, ReadonlyArray<string>>>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = `${scratch}/${name}`;

		yield* Effect.forEach(Rec.toEntries(files), ([file, lines]) =>
			Effect.andThen(
				fs.makeDirectory(path.dirname(`${root}/${file}`), { recursive: true }),
				fs.writeFileString(`${root}/${file}`, Arr.join(lines, "\n")),
			),
		);

		return root;
	});

const mixed = {
	"--home--/one.jsonl": [
		`{"type":"model_change","provider":"openai"}`,
		replyLine({ provider: "openai", timestamp: at("2026-11-01T00:00:00Z"), cost: 1.25 }),
		replyLine({ provider: "openai", timestamp: at("2026-09-01T00:00:00Z"), cost: 100 }),
		replyLine({ provider: "ultra-a", timestamp: at("2026-11-01T00:00:00Z"), cost: 7 }),
		`{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","arguments":{"provider":"openai"}}],"provider":"ultra-a","timestamp":${at("2026-11-01T00:00:00Z")},"usage":{"cost":{"total":11}}}}`,
		"not json",
	],
	"--home--/delegates/child.jsonl": [
		replyLine({ provider: "openai", timestamp: at("2026-11-09T00:00:00Z"), cost: 0.5 }),
	],
	"--home--/notes.txt": [replyLine({ provider: "openai", timestamp: at("2026-11-09T00:00:00Z"), cost: 9 })],
};

test("sums the provider's replies since the cutoff, in root and delegate sessions alike", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const root = yield* sessionsWith("mixed", mixed);
			const got = yield* spendSince({ root, provider: "openai", since });

			expect(got).toEqual({ usd: 1.75, replies: 2 });
		}).pipe(Effect.provide(NodeServices.layer)),
	));

test("a session file last written before the cutoff is not read", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const line = replyLine({ provider: "openai", timestamp: at("2026-11-01T00:00:00Z"), cost: 3 });
			const root = yield* sessionsWith("stale", { "old.jsonl": [line] });
			const longAgo = DateTime.toDate(DateTime.makeUnsafe("2026-09-01T00:00:00Z"));

			yield* fs.utimes(`${root}/old.jsonl`, longAgo, longAgo);

			const got = yield* spendSince({ root, provider: "openai", since });

			expect(got).toEqual({ usd: 0, replies: 0 });
		}).pipe(Effect.provide(NodeServices.layer)),
	));

test("a missing sessions folder fails with its path", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const got = yield* Effect.flip(spendSince({ root: `${scratch}/absent`, provider: "openai", since }));

			expect(got.path).toBe(`${scratch}/absent`);
		}).pipe(Effect.provide(NodeServices.layer)),
	));
