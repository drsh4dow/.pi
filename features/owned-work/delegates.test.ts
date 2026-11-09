import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { harnessFolder, loadRegistry } from "./delegates.ts";

const runtime = ManagedRuntime.make(NodeServices.layer);

test("each delegate's config file is a normalized absolute path, so session entries name it one way", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const folders = { harness: harnessFolder, project: undefined };
			const registry = yield* loadRegistry({ folders, hasModel: () => true });
			const files = Arr.map([...registry.entries.values()], ({ file }) => file);

			expect(files).not.toEqual([]);
			expect(Arr.filter(files, (file) => !path.isAbsolute(file) || path.normalize(file) !== file)).toEqual([]);
		}),
	));

const projects = `${Bun.env["TMPDIR"] ?? "/tmp"}/delegates-test-${String(process.pid)}`;

const defaultModelRows = [
	{
		name: "a harness delegate with no model runs on anthropic/claude-opus-5-5",
		known: ["anthropic/claude-opus-5-5"],
		expect: [
			"cold-reader anthropic/claude-opus-5-5",
			"e2e anthropic/claude-opus-5-5",
			"lead anthropic/claude-opus-5-5",
			"researcher anthropic/claude-opus-5-5",
			"reviewer anthropic/claude-opus-5-5",
		],
	},
	{
		name: "the model registry check runs on the default model",
		known: [],
		expect: Arr.replicate("model anthropic/claude-opus-5-5 is not in the model registry", 5),
	},
	{
		name: "a project delegate overrides the harness delegate of the same name",
		known: ["anthropic/claude-opus-5-5", "anthropic/claude-haiku-4-5"],
		project: {
			"reviewer.ts": `export default { role: "leaf", description: "Reviews.", model: "anthropic/claude-haiku-4-5", tools: ["read"], instructions: "Review." };`,
		},
		expect: [
			"cold-reader anthropic/claude-opus-5-5",
			"e2e anthropic/claude-opus-5-5",
			"lead anthropic/claude-opus-5-5",
			"researcher anthropic/claude-opus-5-5",
			"reviewer anthropic/claude-haiku-4-5",
		],
	},
	{
		name: "an owner that lists another owner is rejected",
		known: ["anthropic/claude-opus-5-5"],
		project: {
			"boss.ts": `export default { role: "owner", description: "Leads.", tools: ["read"], delegates: ["lead"], instructions: "Lead." };`,
		},
		expect: [
			"cold-reader anthropic/claude-opus-5-5",
			"e2e anthropic/claude-opus-5-5",
			"lead anthropic/claude-opus-5-5",
			"researcher anthropic/claude-opus-5-5",
			"reviewer anthropic/claude-opus-5-5",
			"delegates names lead, which is not a known leaf",
		],
	},
];

const projectFolder = (name: string, files: Readonly<Record<string, string>>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const folder = `${projects}/${Str.replaceAll(/\W/gu, "-")(name)}`;

		yield* fs.makeDirectory(folder, { recursive: true });
		yield* Effect.forEach(Rec.toEntries(files), ([file, text]) => fs.writeFileString(`${folder}/${file}`, text));

		return folder;
	});

for (const row of defaultModelRows) {
	test(row.name, () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const hasModel = (provider: string, id: string) => row.known.includes(`${provider}/${id}`);
				const project = row.project === undefined ? undefined : yield* projectFolder(row.name, row.project);
				const registry = yield* loadRegistry({ folders: { harness: harnessFolder, project }, hasModel });
				const models = Arr.map([...registry.entries.values()], ({ name, config }) => `${name} ${config.model}`);

				expect([...Arr.sort(models, Order.String), ...Arr.map(registry.rejected, ({ why }) => why)]).toEqual(
					row.expect,
				);
			}),
		),
	);
}

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${projects}`.quiet())));
