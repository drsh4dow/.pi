import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";

import {
	body,
	callerOf,
	delegate,
	fixtures,
	handed,
	offline,
	refused,
	replies,
	runtime,
	silent,
	started,
	table,
	unlisted,
} from "./brief.fixture.ts";

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${fixtures}`.quiet())));

const Described = Schema.Struct({ description: Schema.String });

test("the model parameter tells the caller each alias with its model, and the panel", () =>
	runtime.runPromise(
		Effect.map(Schema.decodeUnknownEffect(Described)(delegate.parameters.properties.model), ({ description }) => {
			const parts = ["`deep` (anthropic/claude-opus-5-5)", "`gone` (anthropic/nope)", ...table.panel];

			expect(Arr.filter(parts, (part) => !Str.includes(part)(description))).toEqual([]);
		}),
	));

const plainFile = { file: `${fixtures}/plain.md`, text: body };

const profiledFile = { file: `${fixtures}/profiled.md`, text: body };

const briefRows = [
	{
		name: "a message alone runs on the caller's model and thinking level, named by the caller's model with reasoning left out",
		call: { message: "Review the retry cap." },
		naming: replies("Retry cap review."),
		expect: handed({ name: "Retry cap review" }),
	},
	{
		name: "a delegate whose naming call fails is named by the message's first line",
		call: { message: "\nReview the retry cap.\nMore." },
		naming: offline,
		expect: handed({ name: "Review the retry cap." }),
	},
	{
		name: "a naming call with no answer in 5 s falls back to the message's first line",
		call: { message: "Review the retry cap." },
		naming: silent,
		clock: Duration.seconds(5),
		expect: handed({ name: "Review the retry cap." }),
	},
	{
		name: "a caller on a model id the registry lacks, as pi allows, starts its delegate on that model",
		call: { message: "m" },
		caller: { model: unlisted },
		naming: offline,
		expect: {
			...handed({ model: "anthropic/claude-haiku-9-9" }),
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
		expect: handed({ name: "Opus task", model: "anthropic/claude-opus-5-5", thinking: undefined }),
	},
	{
		name: "a model whose provider id holds a slash is found whole",
		call: { message: "m", model: "proxy/anthropic/claude-haiku-5-5" },
		naming: offline,
		expect: handed({ model: "proxy/anthropic/claude-haiku-5-5", thinking: undefined }),
	},
	{
		name: "an alias runs the model the table gives it",
		call: { message: "m", model: "deep" },
		naming: offline,
		expect: handed({ model: "anthropic/claude-opus-5-5", thinking: undefined }),
	},
	{
		name: "an instructions file is read at the call, relative to the working directory",
		call: { message: "m", instructionsFile: "../plain.md" },
		naming: offline,
		expect: handed({ instructions: plainFile }),
	},
	{
		name: "an instructions file under ~/ is read from the home folder",
		call: { message: "m", instructionsFile: "~/plain.md" },
		naming: offline,
		expect: handed({ instructions: plainFile }),
	},
	{
		name: "an instructions file's frontmatter picks the model, thinking level and read-only tools, and stays out of the instructions",
		call: { message: "m", instructionsFile: "../profiled.md" },
		naming: offline,
		expect: handed({
			model: "anthropic/claude-opus-5-5",
			thinking: "low",
			readOnly: true,
			instructions: profiledFile,
		}),
	},
	{
		name: "the call's model wins over the instructions file's, and the file's thinking level still holds",
		call: { message: "m", instructionsFile: "../profiled.md", model: "proxy/anthropic/claude-haiku-5-5" },
		naming: offline,
		expect: handed({
			model: "proxy/anthropic/claude-haiku-5-5",
			thinking: "low",
			readOnly: true,
			instructions: profiledFile,
		}),
	},
	{
		name: "an instructions file that names only a thinking level runs the caller's model at that level",
		call: { message: "m", instructionsFile: "../slow.md" },
		naming: offline,
		expect: handed({ thinking: "low", instructions: { file: `${fixtures}/slow.md`, text: body } }),
	},
	{
		name: "a delegate with a cwd starts in that folder, relative to the caller's",
		call: { message: "m", cwd: ".." },
		naming: offline,
		expect: handed({ cwd: fixtures }),
	},
	{
		name: "a cwd through a symlink starts in the real folder, where the child's session says it ran",
		call: { message: "m", cwd: "../link" },
		naming: offline,
		expect: handed({ cwd: `${fixtures}/work` }),
	},
	{
		name: "a model the registry lacks is a tool error, raised before the naming call",
		call: { message: "m", model: "anthropic/nope" },
		naming: offline,
		expect: refused("model anthropic/nope is not in the model registry"),
	},
	{
		name: "an alias whose model the registry lacks is a tool error that names both",
		call: { message: "m", model: "gone" },
		naming: offline,
		expect: refused("model anthropic/nope, which the alias gone names, is not in the model registry"),
	},
	{
		name: "an instructions file that cannot be read is a tool error, raised before the naming call",
		call: { message: "m", instructionsFile: "missing.md" },
		naming: offline,
		expect: refused("cannot read instructionsFile missing.md: NotFound"),
	},
	{
		name: "a cwd that does not exist is a tool error, raised before the naming call",
		call: { message: "m", cwd: "nowhere" },
		naming: offline,
		expect: refused("cannot start in cwd nowhere: NotFound"),
	},
	{
		name: "a cwd that is a file is a tool error",
		call: { message: "m", cwd: "../plain.md" },
		naming: offline,
		expect: refused("cannot start in cwd ../plain.md: not a folder"),
	},
];

for (const row of briefRows) {
	test(row.name, () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const asked: Array<string> = [];
				const caller = { ...callerOf({ naming: row.naming, asked }), ...row.caller };
				const pending = delegate.execute("call", row.call, undefined, undefined, caller);

				yield* TestClock.adjust(row.clock ?? Duration.zero);

				const { isError, details } = yield* Effect.promise(() => pending);

				const shown = Arr.map(started.splice(0), ({ brief, cwd }) => ({
					name: brief.name,
					model: brief.model,
					thinking: Option.getOrUndefined(brief.thinking),
					readOnly: brief.readOnly,
					instructions: Option.getOrUndefined(brief.instructions),
					cwd,
				}));

				expect({ isError, details, asked, started: shown }).toEqual(row.expect);
			}),
		),
	);
}

const Refusal = Schema.Struct({ message: Schema.String });

const badFrontmatterRows = [
	{ name: "a misspelt key", file: "../misspelt.md", names: "read-only" },
	{ name: "a thinking level pi does not have", file: "../loud.md", names: "thinking" },
	{ name: "a frontmatter block that never closes", file: "../unclosed.md", names: "frontmatter block" },
	{ name: "a frontmatter block below the first line", file: "../late.md", names: "frontmatter block" },
];

for (const row of badFrontmatterRows) {
	test(`an instructions file with ${row.name} is a tool error that names it, and starts nothing`, () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const call = { message: "m", instructionsFile: row.file };

				const { isError, details } = yield* Effect.promise(() =>
					delegate.execute("call", call, undefined, undefined, callerOf({ naming: offline, asked: [] })),
				);

				const { message } = yield* Schema.decodeUnknownEffect(Refusal)(details);

				expect({ isError, started: started.splice(0), names: Str.includes(row.names)(message) }).toEqual({
					isError: true,
					started: [],
					names: true,
				});
			}),
		));
}
