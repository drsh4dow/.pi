import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Str from "effect/String";

const importFrom = /^import[^;]*?from\s+"(?<source>[^"]+)";/gmu;

const importsOfPolicy = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const names = yield* fs.readDirectory(import.meta.dirname);
	const files = Arr.filter(names, Str.endsWith(".ts"));
	const sources = yield* Effect.forEach(files, (file) => fs.readFileString(`${import.meta.dirname}/${file}`));

	return Arr.flatMap(sources, (source) =>
		Arr.map(Arr.fromIterable(Str.matchAll(importFrom)(source)), (match) => match.groups?.["source"] ?? ""),
	);
});

test("the policy engine imports nothing from pi, so another harness's adapter can call it", () =>
	Effect.runPromise(
		Effect.provide(
			Effect.map(importsOfPolicy, (imported) => {
				expect(imported).toContain("effect/Schema");
				expect(Arr.filter(imported, Str.startsWith("@earendil-works/"))).toEqual([]);
			}),
			NodeServices.layer,
		),
	));
