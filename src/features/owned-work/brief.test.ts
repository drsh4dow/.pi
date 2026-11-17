import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { Design } from "#src/client/pi-cli/index.ts";
import {
	body,
	type BriefRow,
	callerOf,
	delegate,
	fixtures,
	goal,
	handed,
	proxied,
	refused,
	runBriefRow,
	runtime,
	started,
	table,
} from "./brief.fixture.ts";
import { roleUses } from "./brief.ts";
import type { Brief } from "./child.ts";

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${fixtures}`.quiet())));

const Described = Schema.Struct({ description: Schema.String });

test("the model parameter tells the caller each alias with its model and its use, and the panel", () =>
	runtime.runPromise(
		Effect.map(Schema.decodeUnknownEffect(Described)(delegate.parameters.properties.model), ({ description }) => {
			const parts = [
				"`deep` (anthropic/claude-opus-5-5) for work that needs taste",
				"`quick` (openai/gpt-6-luna) for mechanical scouting",
				...table.panel,
			];

			expect(Arr.filter(parts, (part) => !Str.includes(part)(description))).toEqual([]);
		}),
	));

const noModel =
	"name a model, since neither the call nor an instructions file does: an alias (`deep`, `quick`, `gone`) or a `provider/id`, your own included";

const plainFile = { file: `${fixtures}/plain.md`, text: body };

const profiledFile = { file: `${fixtures}/profiled.md`, text: body };

const briefRows: ReadonlyArray<BriefRow> = [
	{
		name: "a leaf with a message and a model starts under the name the caller gives",
		call: { name: "retry cap", message: "Review the retry cap.", role: "leaf", model: "quick" },
		expect: handed({ name: "retry cap" }),
	},
	{
		name: "a call that names no model, with no instructions file, is a tool error that lists the aliases",
		call: { name: "m", message: "m", role: "leaf" },
		expect: refused(noModel),
	},
	{
		name: "a call that names no model, with an instructions file that names none, is a tool error",
		call: { name: "m", message: "m", role: "leaf", instructionsFile: "../slow.md" },
		expect: refused(noModel),
	},
	{
		name: "a caller that spells its own model starts its delegate on it at high, whatever its own thinking level",
		call: { name: "m", message: "m", role: "leaf", model: "openai/gpt-6-luna" },
		expect: handed({ model: "openai/gpt-6-luna" }),
	},
	{
		name: "a model the caller names runs at the high thinking level",
		call: { name: "m", message: "m", role: "leaf", model: "anthropic/claude-opus-5-5" },
		expect: handed({ model: "anthropic/claude-opus-5-5" }),
	},
	{
		name: "a model whose provider id holds a slash is found whole",
		call: { name: "m", message: "m", role: "leaf", model: "proxy/openai/gpt-6-luna" },
		expect: handed({ model: "proxy/openai/gpt-6-luna" }),
	},
	{
		name: "an alias runs the model the table gives it",
		call: { name: "m", message: "m", role: "leaf", model: "deep" },
		expect: handed({ model: "anthropic/claude-opus-5-5" }),
	},
	{
		name: "an alias runs on the caller's provider when that provider has the alias's model",
		call: { name: "m", message: "m", role: "leaf", model: "quick" },
		caller: { model: proxied },
		expect: handed({ model: "proxy/openai/gpt-6-luna" }),
	},
	{
		name: "an alias runs on its own provider when the caller's provider lacks the alias's model",
		call: { name: "m", message: "m", role: "leaf", model: "deep" },
		caller: { model: proxied },
		expect: handed({ model: "anthropic/claude-opus-5-5" }),
	},
	{
		name: "an instructions file is read at the call, relative to the working directory",
		call: { name: "m", message: "m", role: "leaf", model: "quick", instructionsFile: "../plain.md" },
		expect: handed({ instructions: plainFile }),
	},
	{
		name: "an instructions file under ~/ is read from the home folder",
		call: { name: "m", message: "m", role: "leaf", model: "quick", instructionsFile: "~/plain.md" },
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
		call: { name: "m", message: "m", instructionsFile: "../profiled.md", model: "proxy/openai/gpt-6-luna" },
		expect: handed({
			model: "proxy/openai/gpt-6-luna",
			thinking: "low",
			readOnly: true,
			instructions: profiledFile,
		}),
	},
	{
		name: "an instructions file that names only a thinking level runs the call's model at that level",
		call: { name: "m", message: "m", role: "leaf", instructionsFile: "../slow.md", model: "quick" },
		expect: handed({ thinking: "low", instructions: { file: `${fixtures}/slow.md`, text: body } }),
	},
	{
		name: "the call's role starts an owner",
		call: { name: "m", message: "m", role: "owner", model: "quick", design: "yours" },
		expect: handed({ role: "owner", design: Design.cases.Yours.make({}) }),
	},
	{
		name: "an instructions file's role holds when the call names none",
		call: { name: "m", message: "m", model: "quick", instructionsFile: "../owned.md", design: "yours" },
		expect: handed({
			role: "owner",
			instructions: { file: `${fixtures}/owned.md`, text: body },
			design: Design.cases.Yours.make({}),
		}),
	},
	{
		name: "an owner at the last level is refused the owner role an instructions file names",
		call: { name: "m", message: "m", model: "quick", instructionsFile: "../owned.md" },
		roles: ["leaf"],
		expect: refused("you start leaves only, at the last owner level: name role `leaf`"),
	},
	{
		name: "an owner at the last level starts a leaf on an owner's instructions file when the call names the leaf role",
		call: { name: "m", message: "m", role: "leaf", model: "quick", instructionsFile: "../owned.md" },
		roles: ["leaf"],
		expect: handed({ instructions: { file: `${fixtures}/owned.md`, text: body } }),
	},
	{
		name: "the call's role wins over the instructions file's",
		call: { name: "m", message: "m", role: "owner", instructionsFile: "../profiled.md", design: "yours" },
		expect: handed({
			role: "owner",
			design: Design.cases.Yours.make({}),
			model: "anthropic/claude-opus-5-5",
			thinking: "low",
			readOnly: true,
			instructions: profiledFile,
		}),
	},
	{
		name: "a call that names no role, with no instructions file, is a tool error that says what each role is for",
		call: { name: "m", message: "m" },
		expect: refused(`name a role, since neither the call nor an instructions file does: ${roleUses}`),
	},
	{
		name: "a call that names no role, with an instructions file that names none, is a tool error",
		call: { name: "m", message: "m", instructionsFile: "../slow.md" },
		expect: refused(`name a role, since neither the call nor an instructions file does: ${roleUses}`),
	},
	{
		name: "a delegate with a cwd starts in that folder, relative to the caller's",
		call: { name: "m", message: "m", role: "leaf", model: "quick", cwd: ".." },
		expect: handed({ cwd: fixtures }),
	},
	{
		name: "a cwd through a symlink starts in the real folder, where the child's session says it ran",
		call: { name: "m", message: "m", role: "leaf", model: "quick", cwd: "../link" },
		expect: handed({ cwd: `${fixtures}/work` }),
	},
	{
		name: "a model the registry lacks is a tool error",
		call: { name: "m", message: "m", role: "leaf", model: "anthropic/nope" },
		expect: refused("model anthropic/nope is not in the model registry"),
	},
	{
		name: "an alias whose model the registry lacks is a tool error that names both",
		call: { name: "m", message: "m", role: "leaf", model: "gone" },
		expect: refused("model anthropic/nope, which the alias gone names, is not in the model registry"),
	},
	{
		name: "a name that is no alias and no provider/id is a tool error that lists the aliases",
		call: { name: "m", message: "m", role: "leaf", model: "scout" },
		expect: refused(
			"scout is not an alias: name an alias (`deep`, `quick`, `gone`) or a `provider/id`, your own included",
		),
	},
	{
		name: "an instructions file that cannot be read is a tool error",
		call: { name: "m", message: "m", role: "leaf", instructionsFile: "missing.md" },
		expect: refused("cannot read instructionsFile missing.md: NotFound"),
	},
	{
		name: "a cwd that does not exist is a tool error",
		call: { name: "m", message: "m", role: "leaf", cwd: "nowhere" },
		expect: refused("cannot start in cwd nowhere: NotFound"),
	},
	{
		name: "a cwd that is a file is a tool error",
		call: { name: "m", message: "m", role: "leaf", cwd: "../plain.md" },
		expect: refused("cannot start in cwd ../plain.md: not a folder"),
	},
];

for (const row of briefRows) {
	test(row.name, () => runBriefRow(row));
}

const Refusal = Schema.Struct({ message: Schema.String });

const badFrontmatterRows = [
	{ name: "a misspelt key", file: "../misspelt.md", names: "read-only" },
	{ name: "a thinking level pi does not have", file: "../loud.md", names: "thinking" },
	{ name: "a role a delegate cannot take", file: "../ruler.md", names: "role" },
	{ name: "a frontmatter block that never closes", file: "../unclosed.md", names: "frontmatter block" },
	{ name: "a frontmatter block below the first line", file: "../late.md", names: "frontmatter block" },
];

for (const row of badFrontmatterRows) {
	test(`an instructions file with ${row.name} is a tool error that names it, and starts nothing`, () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const call = { name: "m", message: "m", goal, instructionsFile: row.file };

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

type Assignable<From, To> = [From] extends [To] ? true : false;

type LeafBrief = Extract<Brief, { readonly role: "leaf" }>;

const leafWithOwnerRules: Assignable<
	Omit<LeafBrief, "ownerRules"> & { readonly ownerRules: Option.Option<string> },
	Brief
> = false;

test("a leaf's brief has no room for owner rules", () => {
	expect(leafWithOwnerRules).toBe(false);
});
