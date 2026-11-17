import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";

import { VerdictCache, verdictCacheLayer } from "./index.ts";

const appendedAfterTornLine = Effect.gen(function* () {
	const { open } = yield* VerdictCache;
	const cache = yield* open({ policy: "v1", pid: 7 });
	const other = yield* open({ policy: "v1", pid: 8 });

	yield* cache.append(["first", "second"]);
	yield* other.append(["third"]);

	return yield* cache.lines;
});

const node = Layer.provideMerge(verdictCacheLayer, NodeServices.layer);

test("a line a crash cut short never swallows the next append, and a read merges every process's file", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const home = yield* fs.makeTempDirectory();
			const folder = `${home}/.local/state/pi-phi-router/system/v1`;

			yield* fs.makeDirectory(folder, { recursive: true });
			yield* fs.writeFileString(`${folder}/7.jsonl`, '\n["torn"');

			const lines = yield* Effect.provideService(
				appendedAfterTornLine,
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromEnvRecord({ HOME: home }),
			);

			expect(Arr.sort(lines, Order.String)).toEqual(["", "", '["torn"', "first", "second", "third"]);
		}).pipe(Effect.provide(node)),
	));
