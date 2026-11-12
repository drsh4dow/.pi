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

import { type Brief, ChildRole } from "./child.ts";
import { type Alias, ModelName, modelNameOf, type ModelTable } from "./models.ts";
import { parseProfile } from "./profile.ts";
import { BadDelegate } from "./work.ts";

const modelDescription = ({ aliases, panel }: ModelTable) => {
	const entries = Rec.toEntries(aliases);
	const named = Arr.map(entries, ([alias, { provider, id, use }]) => `\`${alias}\` (${provider}/${id}) for ${use}`);

	const sentences = [
		`\`provider/id\`, or an alias: ${Arr.join(named, "; ")}.`,
		"It overrides the model an instructions file names, and is required when the file names none.",
		`The panel, for work a skill runs once on each: ${Arr.join(panel, ", ")}.`,
	];

	return Arr.join(sentences, " ");
};

export const roleUses =
	"`owner` for a slice to build, verify and commit, which may need a playbook or delegates of its own; `leaf` for one bounded task, such as a search, a review, a verification lane or a scoped edit";

const roleDescription = `${roleUses}. A leaf gets no playbooks and starts no delegates. It overrides the role an instructions file names, and is required when the file names none.`;

export const delegateParams = (table: ModelTable) => {
	const model = Type.String({ description: modelDescription(table) });

	return Type.Object({
		name: Type.String({
			pattern: String.raw`\S`,
			description:
				"A few words that tell this delegate apart from the others you run, such as `review auth` or `classify opus 2`. The human sees it in their list of running agents.",
		}),
		message: Type.String({
			pattern: String.raw`\S`,
			description: "Everything the delegate needs. You cannot send it anything later, and it cannot ask you.",
		}),
		/** A plain string enum, as pi's `StringEnum` builds, since some providers refuse `anyOf` of constants. */
		role: Type.Optional(
			Type.Unsafe<ChildRole>({ type: "string", enum: [...ChildRole.literals], description: roleDescription }),
		),
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
		group: Type.Optional(
			Type.String({
				pattern: String.raw`\S`,
				description:
					"A few words for what the group's work has in common, such as `principles eval`. Delegates you start with the same `group` while that group runs join it, and it wakes you once with all their answers.",
			}),
		),
	});
};

export type DelegateParams = ReturnType<typeof delegateParams>;

export type Caller = Pick<ExtensionContext, "cwd" | "model"> & {
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAll">;
};

/** `provider/id` of the alias's model on the caller's provider when that provider has it, so a delegate stays on its parent's account. */
const aliasedModel = (ctx: Caller, { provider: home, id }: Alias) => {
	const registry = ctx.modelRegistry.getAll();

	const own = Option.filter(Option.fromUndefinedOr(ctx.model), ({ provider }) =>
		Arr.some(registry, (model) => model.provider === provider && model.id === id),
	);

	const provider = Option.match(own, { onNone: () => home, onSome: (model) => model.provider });

	return `${provider}/${id}`;
};

const modelOf = (ctx: Caller, { aliases }: ModelTable, name: ModelName) => {
	const { model, source } = ModelName.$match(name, {
		Spelled: ({ key }) => ({ model: key, source: "" }),
		Alias: ({ alias }) =>
			Option.match(Rec.get(aliases, alias), {
				onNone: () => ({ model: alias, source: "" }),
				onSome: (entry) => ({
					model: aliasedModel(ctx, entry),
					source: `, which the alias ${alias} names,`,
				}),
			}),
	});

	return Effect.fromOption(
		Arr.findFirst(ctx.modelRegistry.getAll(), ({ provider, id }) => `${provider}/${id}` === model),
		() => BadDelegate.make({ why: `model ${model}${source} is not in the model registry` }),
	).pipe(Effect.as(model));
};

/** The thinking level a delegate starts at unless its instructions file names one. pi clamps it to what the model supports. */
const delegateThinking = "high";

const modelChoices = ({ aliases }: ModelTable) => {
	const named = Arr.map(Rec.keys(aliases), (alias) => `\`${alias}\``);

	return `an alias (${Arr.join(named, ", ")}) or a \`provider/id\`, your own included`;
};

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

interface Parsed {
	readonly brief: Brief;
	readonly cwd: Option.Option<string>;
}

export const parseCall = Effect.fn("parseCall")(function* (
	ctx: Caller,
	table: ModelTable,
	call: Static<DelegateParams>,
) {
	const cwd = yield* Effect.transposeOption(
		Option.map(Option.fromUndefinedOr(call.cwd), (folder) => folderOf(ctx.cwd, folder)),
	);

	const profile = yield* Effect.transposeOption(
		Option.map(Option.fromUndefinedOr(call.instructionsFile), (file) => instructionsOf(ctx.cwd, file)),
	);

	const role = yield* Effect.fromOption(
		Option.orElse(Option.fromUndefinedOr(call.role), () => Option.flatMap(profile, (own) => own.role)),
		() => BadDelegate.make({ why: `name a role, since neither the call nor an instructions file does: ${roleUses}` }),
	);

	const named = Option.orElse(Option.map(Option.fromUndefinedOr(call.model), modelNameOf), () =>
		Option.flatMap(profile, (own) => own.model),
	);

	const wanted = yield* Effect.fromOption(named, () =>
		BadDelegate.make({
			why: `name a model, since neither the call nor an instructions file does: ${modelChoices(table)}`,
		}),
	);

	const model = yield* modelOf(ctx, table, wanted);

	const brief: Brief = {
		name: call.name,
		message: call.message,
		role,
		model,
		thinking: Option.orElseSome(
			Option.flatMap(profile, (own) => own.thinking),
			() => delegateThinking,
		),
		readOnly: Option.exists(profile, (own) => own.readOnly),
		instructions: Option.map(profile, ({ file, text }) => ({ file, text })),
	};

	const parsed: Parsed = { brief, cwd };

	return parsed;
});
