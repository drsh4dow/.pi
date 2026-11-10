import { expect, test } from "bun:test";

import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Struct from "effect/Struct";
import * as TestClock from "effect/testing/TestClock";

import { type Brief, Self } from "./child.ts";
import { Ledger } from "./ledger.ts";
import { Tools } from "./tools.ts";
import { StartRequest, WorkRef } from "./work.ts";

const haiku = getBuiltinModel("anthropic", "claude-haiku-5-5");

const opus = getBuiltinModel("anthropic", "claude-opus-5-5");

const unlisted = { ...haiku, id: "claude-haiku-9-9" };

const proxied = { ...haiku, provider: "proxy/anthropic" };

const harness = Bun.fileURLToPath(new URL("../..", import.meta.url));

const briefs: Array<Brief> = [];

const ledger = Layer.mock(Ledger)({
	start: (request) =>
		Effect.sync(() => {
			if (StartRequest.$is("Delegate")(request)) {
				briefs.push(request.brief);
			}

			return {
				ref: WorkRef("delegate-1"),
				kind: "delegate" as const,
				terminal: Option.none(),
				ready: Option.none(),
			};
		}),
});

const home = ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: harness }));

const runtime = ManagedRuntime.make(Layer.mergeAll(NodeServices.layer, ledger, TestClock.layer(), home));

const toolsOf = (self: Self) => {
	const tools: Array<Pick<ToolDefinition, "name" | "promptGuidelines" | "execute">> = [];

	Tools.register(
		{
			registerTool: (tool) => {
				tools.push(tool);
			},
		},
		runtime,
		self,
		{ cwd: "/", dir: "/d" },
	);

	return tools;
};

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
		const tools = toolsOf(row.self);
		const names = Arr.map(tools, ({ name }) => name);

		expect({
			rest: Arr.filter(names, (name) => name !== "delegate"),
			delegate: Arr.contains(names, "delegate"),
			lastLevelLine: Arr.some(
				Arr.flatMap(tools, ({ promptGuidelines }) => promptGuidelines ?? []),
				Str.includes("cannot start delegates of their own"),
			),
		}).toEqual({ rest: ["serve", "watch", "group", "stop"], ...row.expect });
	});
}

const delegate = Tools.delegate(runtime, 2, { cwd: "/", dir: "/d" });

type Naming = (stream: AssistantMessageEventStream) => void;

const offline: Naming = () => {
	throw new Error("offline");
};

const replies =
	(text: string): Naming =>
	(stream) => {
		stream.end(fauxAssistantMessage(text));
	};

const silent: Naming = () => {};

const callerOf = (naming: Naming, asked: Array<string>): Parameters<typeof delegate.execute>[4] => ({
	cwd: import.meta.dirname,
	model: haiku,
	thinkingLevel: "high",
	modelRegistry: {
		getAll: () => [haiku, opus, proxied],
		streamSimple: (model, _context, options) => {
			const stream = createAssistantMessageEventStream();

			asked.push(`${model.id} with ${Arr.join(Struct.keys(options ?? {}), ", ")}`);
			naming(stream);

			return stream;
		},
	},
});

const coldReader = `${harness}agent/instructions/cold-reader.md`;

const coldReaderText = await Bun.file(coldReader).text();

const namedOnHaiku = ["claude-haiku-5-5 with maxTokens, signal"];

const handed = { isError: false, details: { ref: "delegate-1", kind: "delegate" }, asked: namedOnHaiku };

const refused = (message: string) => ({
	isError: true,
	details: { error: "BadDelegate", message },
	briefs: [],
	asked: [],
});

const briefRows = [
	{
		name: "a message alone runs on the caller's model and thinking level, named by the caller's model with reasoning left out",
		call: { message: "Review the retry cap." },
		naming: replies("Retry cap review."),
		expect: { ...handed, briefs: [["Retry cap review", "anthropic/claude-haiku-5-5", "high", undefined]] },
	},
	{
		name: "a delegate whose naming call fails is named by the message's first line",
		call: { message: "\nReview the retry cap.\nMore." },
		naming: offline,
		expect: { ...handed, briefs: [["Review the retry cap.", "anthropic/claude-haiku-5-5", "high", undefined]] },
	},
	{
		name: "a naming call with no answer in 5 s falls back to the message's first line",
		call: { message: "Review the retry cap." },
		naming: silent,
		clock: Duration.seconds(5),
		expect: { ...handed, briefs: [["Review the retry cap.", "anthropic/claude-haiku-5-5", "high", undefined]] },
	},
	{
		name: "a caller on a model id the registry lacks, as pi allows, starts its delegate on that model",
		call: { message: "Review the retry cap." },
		caller: { model: unlisted },
		naming: offline,
		expect: {
			...handed,
			briefs: [["Review the retry cap.", "anthropic/claude-haiku-9-9", "high", undefined]],
			asked: ["claude-haiku-9-9 with maxTokens, signal"],
		},
	},
	{
		name: "a caller on no model that names none is a tool error that says so",
		call: { message: "m" },
		caller: { model: undefined },
		naming: offline,
		expect: refused("name a model, since you run on none"),
	},
	{
		name: "a model the caller names runs at pi's default thinking level for it, and the caller's own model names it",
		call: { message: "m", model: "anthropic/claude-opus-5-5" },
		naming: replies("Opus task"),
		expect: { ...handed, briefs: [["Opus task", "anthropic/claude-opus-5-5", undefined, undefined]] },
	},
	{
		name: "a model whose provider id holds a slash is found whole",
		call: { message: "m", model: "proxy/anthropic/claude-haiku-5-5" },
		naming: offline,
		expect: { ...handed, briefs: [["m", "proxy/anthropic/claude-haiku-5-5", undefined, undefined]] },
	},
	{
		name: "an instructions file is read at the call, relative to the working directory",
		call: { message: "m", instructionsFile: "../../agent/instructions/cold-reader.md" },
		naming: offline,
		expect: {
			...handed,
			briefs: [["m", "anthropic/claude-haiku-5-5", "high", { file: coldReader, text: coldReaderText }]],
		},
	},
	{
		name: "an instructions file under ~/ is read from the home folder",
		call: { message: "m", instructionsFile: "~/agent/instructions/cold-reader.md" },
		naming: offline,
		expect: {
			...handed,
			briefs: [["m", "anthropic/claude-haiku-5-5", "high", { file: coldReader, text: coldReaderText }]],
		},
	},
	{
		name: "a model the registry lacks is a tool error, raised before the naming call",
		call: { message: "m", model: "anthropic/nope" },
		naming: offline,
		expect: refused("model anthropic/nope is not in the model registry"),
	},
	{
		name: "an instructions file that cannot be read is a tool error, raised before the naming call",
		call: { message: "m", instructionsFile: "missing.md" },
		naming: offline,
		expect: refused("cannot read instructionsFile missing.md: NotFound"),
	},
];

for (const row of briefRows) {
	test(row.name, () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const asked: Array<string> = [];
				const caller = { ...callerOf(row.naming, asked), ...row.caller };
				const pending = delegate.execute("call", row.call, undefined, undefined, caller);

				yield* TestClock.adjust(row.clock ?? Duration.zero);

				const { isError, details } = yield* Effect.promise(() => pending);

				const shown = Arr.map(briefs.splice(0), ({ name, model, thinking, instructions }) => [
					name,
					model,
					Option.getOrUndefined(thinking),
					Option.getOrUndefined(instructions),
				]);

				expect({ isError, details, asked, briefs: shown }).toEqual(row.expect);
			}),
		),
	);
}

const validated = (message: string) => () => {
	validateToolArguments(delegate, { type: "toolCall", id: "c", name: "delegate", arguments: { message } });
};

test("pi refuses a delegate message of only spaces, tabs and newlines, and passes one with a word", () => {
	expect(validated(" \n\t ")).toThrow();
	expect(validated("\n Review it. ")).not.toThrow();
});
