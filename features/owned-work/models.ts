import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { BadDelegate } from "./work.ts";

export type ModelKey = `${string}/${string}`;

const isModelKey = (name: string): name is ModelKey => Str.includes("/")(name);

export type ModelName = Data.TaggedEnum<{
	Alias: { readonly alias: string };
	Spelled: { readonly key: ModelKey };
}>;

export const ModelName = Data.taggedEnum<ModelName>();

export const modelNameOf = (name: string): ModelName =>
	isModelKey(name) ? ModelName.Spelled({ key: name }) : ModelName.Alias({ alias: name });

/** A model and the work it is for. It runs on the caller's provider when that provider has the model id, so a delegate stays on its parent's account, and on `provider` otherwise. */
export interface Alias {
	readonly provider: string;
	readonly id: string;
	readonly use: string;
}

export interface ModelTable {
	readonly aliases: Readonly<Record<string, Alias>>;
	/** Model names, aliases or `provider/id`, one per provider. */
	readonly panel: ReadonlyArray<string>;
}

/** An alias never looks like a `provider/id`, so a spelled model always means that model. */
type Aliases = Readonly<Record<string, Alias> & Record<ModelKey, never>>;

export const aliases = {
	judgment: {
		provider: "ultra-a",
		id: "claude-opus-5-5",
		use: "implementation, design, synthesis, and anything that needs taste",
	},
	investigator: {
		provider: "openai",
		id: "gpt-6.1-sol",
		use: "research, web search, code review, audits, investigation, mechanical scouting, fan-out aggregation, and a second opinion from another model family",
	},
	divergent: {
		provider: "opencode-go",
		id: "glm-5.3-flash",
		use: "the arena skill's third candidate, and nothing else",
	},
} as const satisfies Aliases;

const panel: ReadonlyArray<keyof typeof aliases> = ["judgment", "investigator"];

export const modelTable: ModelTable = { aliases, panel };

export type ModelCaller = Pick<ExtensionContext, "model"> & {
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAll">;
};

export const modelDescription = (table: ModelTable) => {
	const entries = Rec.toEntries(table.aliases);
	const named = Arr.map(entries, ([alias, { provider, id, use }]) => `\`${alias}\` (${provider}/${id}) for ${use}`);

	const sentences = [
		`\`provider/id\`, or an alias: ${Arr.join(named, "; ")}.`,
		"It overrides the model an instructions file names, and is required when the file names none.",
		`The panel, for work a skill runs once on each: ${Arr.join(table.panel, ", ")}.`,
	];

	return Arr.join(sentences, " ");
};

/** `provider/id` of the alias's model on the caller's provider when that provider has it, so a delegate stays on its parent's account. */
const aliasedModel = (ctx: ModelCaller, { provider: home, id }: Alias) => {
	const registry = ctx.modelRegistry.getAll();

	const own = Option.filter(Option.fromUndefinedOr(ctx.model), ({ provider }) =>
		Arr.some(registry, (model) => model.provider === provider && model.id === id),
	);

	const provider = Option.match(own, { onNone: () => home, onSome: (model) => model.provider });

	return `${provider}/${id}`;
};

export const modelChoices = (table: ModelTable) => {
	const named = Arr.map(Rec.keys(table.aliases), (alias) => `\`${alias}\``);

	return `an alias (${Arr.join(named, ", ")}) or a \`provider/id\`, your own included`;
};

export const modelOf = Effect.fn("modelOf")(function* (ctx: ModelCaller, table: ModelTable, name: ModelName) {
	const { model, source } = yield* ModelName.$match(name, {
		Spelled: ({ key }) => Effect.succeed({ model: key, source: "" }),
		Alias: ({ alias }) =>
			Effect.fromOption(Rec.get(table.aliases, alias), () =>
				BadDelegate.make({ why: `${alias} is not an alias: name ${modelChoices(table)}` }),
			).pipe(
				Effect.map((entry) => ({
					model: aliasedModel(ctx, entry),
					source: `, which the alias ${alias} names,`,
				})),
			),
	});

	return yield* Effect.fromOption(
		Arr.findFirst(ctx.modelRegistry.getAll(), ({ provider, id }) => `${provider}/${id}` === model),
		() => BadDelegate.make({ why: `model ${model}${source} is not in the model registry` }),
	).pipe(Effect.as(model));
});
