import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import {
	body,
	callerOf,
	delegate,
	fixtures,
	handed,
	proxied,
	refused,
	runtime,
	started,
	table,
	unlisted,
} from "./brief.fixture.ts";

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${fixtures}`.quiet())));

const Described = Schema.Struct({ description: Schema.String });

test("the model parameter tells the caller each alias with its model, where it runs, and the panel", () =>
	runtime.runPromise(
		Effect.map(Schema.decodeUnknownEffect(Described)(delegate.parameters.properties.model), ({ description }) => {
			const parts = ["`deep` (claude-opus-5-5)", "`gone` (nope)", "on anthropic otherwise", ...table.panel];

			expect(Arr.filter(parts, (part) => !Str.includes(part)(description))).toEqual([]);
		}),
	));

const plainFile = { file: `${fixtures}/plain.md`, text: body };

const profiledFile = { file: `${fixtures}/profiled.md`, text: body };

const briefRows = [
	{
		name: "a message alone runs on the caller's model and thinking level, under the name the caller gives",
		call: { name: "retry cap", message: "Review the retry cap." },
		expect: handed({ name: "retry cap" }),
	},
	{
		name: "a caller on a model id the registry lacks, as pi allows, starts its delegate on that model",
		call: { name: "m", message: "m" },
		caller: { model: unlisted },
		expect: handed({ model: "anthropic/claude-haiku-9-9" }),
	},
	{
		name: "a caller on no model that names none is a tool error that says so",
		call: { name: "m", message: "m" },
		caller: { model: undefined },
		expect: refused("name a model, since you run on none"),
	},
	{
		name: "a model the caller names runs at pi's default thinking level for it",
		call: { name: "m", message: "m", model: "anthropic/claude-opus-5-5" },
		expect: handed({ model: "anthropic/claude-opus-5-5", thinking: undefined }),
	},
	{
		name: "a model whose provider id holds a slash is found whole",
		call: { name: "m", message: "m", model: "proxy/anthropic/claude-haiku-5-5" },
		expect: handed({ model: "proxy/anthropic/claude-haiku-5-5", thinking: undefined }),
	},
	{
		name: "an alias runs the model the table gives it",
		call: { name: "m", message: "m", model: "deep" },
		expect: handed({ model: "anthropic/claude-opus-5-5", thinking: undefined }),
	},
	{
		name: "an alias runs on the caller's provider when that provider has the alias's model",
		call: { name: "m", message: "m", model: "quick" },
		caller: { model: proxied },
		expect: handed({ model: "proxy/anthropic/claude-haiku-5-5", thinking: undefined }),
	},
	{
		name: "an alias runs on the fallback provider when the caller's provider lacks the alias's model",
		call: { name: "m", message: "m", model: "deep" },
		caller: { model: proxied },
		expect: handed({ model: "anthropic/claude-opus-5-5", thinking: undefined }),
	},
	{
		name: "an instructions file is read at the call, relative to the working directory",
		call: { name: "m", message: "m", instructionsFile: "../plain.md" },
		expect: handed({ instructions: plainFile }),
	},
	{
		name: "an instructions file under ~/ is read from the home folder",
		call: { name: "m", message: "m", instructionsFile: "~/plain.md" },
		expect: handed({ instructions: plainFile }),
	},
	{
		name: "an instructions file's frontmatter picks the model, thinking level and read-only tools, and stays out of the instructions",
		call: { name: "m", message: "m", instructionsFile: "../profiled.md" },
		expect: handed({
			model: "anthropic/claude-opus-5-5",
			thinking: "low",
			readOnly: true,
			instructions: profiledFile,
		}),
	},
	{
		name: "the call's model wins over the instructions file's, and the file's thinking level still holds",
		call: { name: "m", message: "m", instructionsFile: "../profiled.md", model: "proxy/anthropic/claude-haiku-5-5" },
		expect: handed({
			model: "proxy/anthropic/claude-haiku-5-5",
			thinking: "low",
			readOnly: true,
			instructions: profiledFile,
		}),
	},
	{
		name: "an instructions file that names only a thinking level runs the caller's model at that level",
		call: { name: "m", message: "m", instructionsFile: "../slow.md" },
		expect: handed({ thinking: "low", instructions: { file: `${fixtures}/slow.md`, text: body } }),
	},
	{
		name: "a delegate with a cwd starts in that folder, relative to the caller's",
		call: { name: "m", message: "m", cwd: ".." },
		expect: handed({ cwd: fixtures }),
	},
	{
		name: "a cwd through a symlink starts in the real folder, where the child's session says it ran",
		call: { name: "m", message: "m", cwd: "../link" },
		expect: handed({ cwd: `${fixtures}/work` }),
	},
	{
		name: "a model the registry lacks is a tool error",
		call: { name: "m", message: "m", model: "anthropic/nope" },
		expect: refused("model anthropic/nope is not in the model registry"),
	},
	{
		name: "an alias whose model the registry lacks is a tool error that names both",
		call: { name: "m", message: "m", model: "gone" },
		expect: refused("model anthropic/nope, which the alias gone names, is not in the model registry"),
	},
	{
		name: "an instructions file that cannot be read is a tool error",
		call: { name: "m", message: "m", instructionsFile: "missing.md" },
		expect: refused("cannot read instructionsFile missing.md: NotFound"),
	},
	{
		name: "a cwd that does not exist is a tool error",
		call: { name: "m", message: "m", cwd: "nowhere" },
		expect: refused("cannot start in cwd nowhere: NotFound"),
	},
	{
		name: "a cwd that is a file is a tool error",
		call: { name: "m", message: "m", cwd: "../plain.md" },
		expect: refused("cannot start in cwd ../plain.md: not a folder"),
	},
];

for (const row of briefRows) {
	test(row.name, () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const caller = { ...callerOf(), ...row.caller };

				const { isError, details } = yield* Effect.promise(() =>
					delegate.execute("call", row.call, undefined, undefined, caller),
				);

				const shown = Arr.map(started.splice(0), ({ brief, cwd }) => ({
					name: brief.name,
					model: brief.model,
					thinking: Option.getOrUndefined(brief.thinking),
					readOnly: brief.readOnly,
					instructions: Option.getOrUndefined(brief.instructions),
					cwd,
				}));

				expect({ isError, details, started: shown }).toEqual(row.expect);
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
				const call = { name: "m", message: "m", instructionsFile: row.file };

				const { isError, details } = yield* Effect.promise(() =>
					delegate.execute("call", call, undefined, undefined, callerOf()),
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
