import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { web } from "./index.ts";

const registered = () => {
	const tools: Array<{ readonly name: string }> = [];

	const feature = web({
		registerTool: (tool) => {
			tools.push(tool);
		},
	});

	return { feature, tools };
};

const definitionsHash = "5664cca77f140ea098388c1a84fc835778a8d99d707c0a998a98800cd7ef2988";

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

test("the web entry gives pi web_search, web_fetch and the folder holding both skills", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { feature, tools } = registered();

			const skillFiles = Arr.flatMap(feature.resourcesDiscover().skillPaths, (path) => [
				`${path}/web-docs/SKILL.md`,
				`${path}/deep-research/SKILL.md`,
			]);

			const present = yield* Effect.forEach(skillFiles, (file) => fs.exists(file));

			yield* Effect.promise(feature.shutdown);
			expect({ names: Arr.map(tools, (tool) => tool.name), present }).toEqual({
				names: ["web_search", "web_fetch"],
				present: [true, true],
			});
		}).pipe(Effect.provide(NodeServices.layer)),
	));

test("the tool definitions match the recorded bytes, so the prompt cache holds across processes", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { feature, tools } = registered();
			const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(tools);

			yield* Effect.promise(feature.shutdown);
			expect({ sha256: sha256(json), under3Kb: json.length < 3072 }).toEqual({
				sha256: definitionsHash,
				under3Kb: true,
			});
		}),
	));
