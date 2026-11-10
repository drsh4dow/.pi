import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { type Static, Type } from "typebox";

import type { Brief } from "./child.ts";
import { ModelName, modelNameOf, type ModelTable } from "./models.ts";
import { nameOf } from "./naming.ts";
import { parseProfile } from "./profile.ts";
import { BadDelegate } from "./work.ts";

const modelDescription = ({ aliases, panel }: ModelTable) => {
	const entries = Rec.toEntries(aliases);
	const named = Arr.map(entries, ([alias, id]) => `\`${alias}\` (${id})`);

	const sentences = [
		`\`provider/id\`, or an alias: ${Arr.join(named, ", ")}.`,
		"It overrides the model an instructions file names. Your own model and thinking level when left out.",
		`The panel, for work a skill runs once on each: ${Arr.join(panel, ", ")}.`,
	];

	return Arr.join(sentences, " ");
};

export const delegateParams = (table: ModelTable) => {
	const model = Type.String({ description: modelDescription(table) });

	return Type.Object({
		message: Type.String({
			pattern: String.raw`\S`,
			description: "Everything the delegate needs. You cannot send it anything later, and it cannot ask you.",
		}),
		instructionsFile: Type.Optional(
			Type.String({
				description:
					"A file whose text the delegate keeps as standing instructions, such as one a skill names. `~/` and paths relative to your working directory work.",
			}),
		),
		model: Type.Optional(model),
		cwd: Type.Optional(
			Type.String({
				description: "The folder the delegate starts in, such as its own git worktree. Yours when left out.",
			}),
		),
	});
};

export type DelegateParams = ReturnType<typeof delegateParams>;

export type Caller = Pick<ExtensionContext, "cwd" | "model" | "thinkingLevel"> & {
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAll" | "streamSimple">;
};

type Checking = Pick<Caller, "cwd" | "model" | "thinkingLevel"> & {
	readonly modelRegistry: Pick<Caller["modelRegistry"], "getAll">;
};

type Naming = Pick<Caller, "model"> & {
	readonly modelRegistry: Pick<Caller["modelRegistry"], "streamSimple">;
};

const modelOf = (ctx: Checking, { aliases }: ModelTable, wanted: Option.Option<ModelName>) =>
	Option.match(wanted, {
		onNone: () =>
			Effect.fromOption(Option.fromUndefinedOr(ctx.model), () =>
				BadDelegate.make({ why: "name a model, since you run on none" }),
			).pipe(
				Effect.map(({ provider, id }) => ({
					model: `${provider}/${id}`,
					thinking: Option.fromUndefinedOr(ctx.thinkingLevel),
				})),
			),
		onSome: (name) => {
			const { model, source } = ModelName.$match(name, {
				Spelled: ({ key }) => ({ model: key, source: "" }),
				Alias: ({ alias }) =>
					Option.match(Rec.get(aliases, alias), {
						onNone: () => ({ model: alias, source: "" }),
						onSome: (key) => ({ model: key, source: `, which the alias ${alias} names,` }),
					}),
			});

			return Effect.fromOption(
				Arr.findFirst(ctx.modelRegistry.getAll(), ({ provider, id }) => `${provider}/${id}` === model),
				() => BadDelegate.make({ why: `model ${model}${source} is not in the model registry` }),
			).pipe(Effect.as({ model, thinking: Option.none<string>() }));
		},
	});

const absoluteOf = Effect.fn("absoluteOf")(function* (cwd: string, file: string) {
	const path = yield* Path.Path;
	const home = yield* Effect.orElseSucceed(Config.String("HOME"), () => "~");

	return path.resolve(cwd, Str.replace(/^~(?=\/)/u, home)(file));
});

const instructionsOf = Effect.fn("instructionsOf")(function* (cwd: string, file: string) {
	const fs = yield* FileSystem.FileSystem;
	const absolute = yield* absoluteOf(cwd, file);

	const text = yield* Effect.mapError(fs.readFileString(absolute), (error) =>
		BadDelegate.make({ why: `cannot read instructionsFile ${file}: ${error.reason._tag}` }),
	);

	const profile = yield* Effect.mapError(parseProfile(text), (why) =>
		BadDelegate.make({ why: `instructionsFile ${file} has bad frontmatter: ${why}` }),
	);

	return { ...profile, file: absolute };
});

/** The real path, since the child records that one in its session, and pi finds the session by comparing the two as text. */
const folderOf = Effect.fn("folderOf")(function* (cwd: string, folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const absolute = yield* absoluteOf(cwd, folder);
	const refusal = (why: string) => BadDelegate.make({ why: `cannot start in cwd ${folder}: ${why}` });
	const real = yield* Effect.mapError(fs.realPath(absolute), (error) => refusal(error.reason._tag));
	const info = yield* Effect.mapError(fs.stat(real), (error) => refusal(error.reason._tag));

	return info.type === "Directory" ? real : yield* refusal("not a folder");
});

interface Checked {
	readonly brief: Omit<Brief, "name">;
	readonly cwd: Option.Option<string>;
}

const check = Effect.fn("check")(function* (ctx: Checking, table: ModelTable, call: Static<DelegateParams>) {
	const cwd = yield* Effect.transposeOption(
		Option.map(Option.fromUndefinedOr(call.cwd), (folder) => folderOf(ctx.cwd, folder)),
	);

	const profile = yield* Effect.transposeOption(
		Option.map(Option.fromUndefinedOr(call.instructionsFile), (file) => instructionsOf(ctx.cwd, file)),
	);

	const wanted = Option.orElse(Option.map(Option.fromUndefinedOr(call.model), modelNameOf), () =>
		Option.flatMap(profile, (own) => own.model),
	);

	const { model, thinking } = yield* modelOf(ctx, table, wanted);

	const brief: Omit<Brief, "name"> = {
		message: call.message,
		model,
		thinking: Option.orElse(
			Option.flatMap(profile, (own) => own.thinking),
			() => thinking,
		),
		readOnly: Option.exists(profile, (own) => own.readOnly),
		instructions: Option.map(profile, ({ file, text }) => ({ file, text })),
	};

	const checked: Checked = { brief, cwd };

	return checked;
});

const named = (
	ctx: Naming,
	{ brief, cwd }: Checked,
): Effect.Effect<{ readonly brief: Brief; readonly cwd: Option.Option<string> }> =>
	Effect.map(nameOf(ctx.modelRegistry, ctx.model, brief.message), (name) => ({ brief: { ...brief, name }, cwd }));

export const parseCall = Effect.fn("parseCall")(function* (
	ctx: Caller,
	table: ModelTable,
	call: Static<DelegateParams>,
) {
	const checked = yield* check(ctx, table, call);

	return yield* named(ctx, checked);
});
