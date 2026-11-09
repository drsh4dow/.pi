import { expect, test } from "bun:test";

import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { Self } from "./child.ts";
import { Ledger } from "./ledger.ts";
import { briefOf, Tools } from "./tools.ts";

const model = getBuiltinModel("anthropic", "claude-haiku-5-5");

const runtime = ManagedRuntime.make(Layer.mergeAll(NodeServices.layer, Layer.mock(Ledger)({})));

const levelRows = [
	{ name: "the root", self: Self.Root({ role: "root", level: 1 }), expect: { delegate: true, lastLevelLine: false } },
	{
		name: "a level-2 delegate, told its delegates cannot delegate,",
		self: Self.Delegate({ role: "delegate", level: 2, slice: "s" }),
		expect: { delegate: true, lastLevelLine: true },
	},
	{
		name: "a delegate at the last level",
		self: Self.Delegate({ role: "delegate", level: 3, slice: "s" }),
		expect: { delegate: false, lastLevelLine: false },
	},
];

for (const row of levelRows) {
	test(`${row.name} ${row.expect.delegate ? "gets" : "does not get"} the delegate tool, and always gets the rest`, () => {
		const names: Array<string> = [];
		const guidelines: Array<string> = [];

		Tools.register(
			{
				registerTool: (tool) => {
					names.push(tool.name);
					guidelines.push(...(tool.promptGuidelines ?? []));
				},
			},
			runtime,
			row.self,
			{ cwd: "/", dir: "/d" },
		);

		expect({
			rest: Arr.filter(names, (name) => name !== "delegate"),
			delegate: Arr.contains(names, "delegate"),
			lastLevelLine: Arr.some(guidelines, Str.includes("cannot start delegates of their own")),
		}).toEqual({ rest: ["serve", "watch", "group", "stop"], ...row.expect });
	});
}

const callerOf = (asked: Array<string>) => ({
	cwd: import.meta.dirname,
	model,
	thinkingLevel: "high" as const,
	modelRegistry: {
		find: (provider: string, id: string) =>
			`${provider}/${id}` === "anthropic/claude-haiku-5-5" ? model : undefined,
		streamSimple: () => {
			asked.push("named");

			throw new Error("offline");
		},
	},
});

const coldReader = Bun.fileURLToPath(new URL("../../agent/instructions/cold-reader.md", import.meta.url));

const briefRows = [
	{
		name: "a message alone runs on the caller's model and thinking level, named by its first line when naming fails",
		call: { message: "\nReview the retry cap.\nMore." },
		expect: { brief: ["Review the retry cap.", "anthropic/claude-haiku-5-5", "high", undefined], asked: ["named"] },
	},
	{
		name: "a model the caller names runs at pi's default thinking level for that model",
		call: { message: "m", model: "anthropic/claude-haiku-5-5" },
		expect: { brief: ["m", "anthropic/claude-haiku-5-5", undefined, undefined], asked: ["named"] },
	},
	{
		name: "an instructions file is read at the call, relative to the working directory",
		call: { message: "m", instructionsFile: "../../agent/instructions/cold-reader.md" },
		expect: { brief: ["m", "anthropic/claude-haiku-5-5", "high", coldReader], asked: ["named"] },
	},
	{
		name: "a model the registry lacks is refused before the naming call",
		call: { message: "m", model: "anthropic/nope" },
		expect: { error: "model anthropic/nope is not in the model registry", asked: [] },
	},
	{
		name: "an instructions file that cannot be read is refused before the naming call",
		call: { message: "m", instructionsFile: "missing.md" },
		expect: { error: "cannot read instructionsFile missing.md: NotFound", asked: [] },
	},
];

for (const row of briefRows) {
	test(row.name, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const asked: Array<string> = [];

				const got = yield* briefOf(callerOf(asked), row.call).pipe(
					Effect.match({
						onFailure: ({ why }) => ({ error: why }),
						onSuccess: ({ name, model: chosen, thinking, instructions }) => ({
							brief: [
								name,
								chosen,
								Option.getOrUndefined(thinking),
								Option.getOrUndefined(Option.map(instructions, ({ file }) => file)),
							],
						}),
					}),
				);

				expect({ ...got, asked }).toEqual(row.expect);
			}).pipe(Effect.provide(NodeServices.layer)),
		),
	);
}
