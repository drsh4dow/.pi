import * as Data from "effect/Data";
import * as Str from "effect/String";

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

const aliases = {
	judgment: {
		provider: "ultra-a",
		id: "claude-opus-5-5",
		use: "implementation, design, synthesis, and anything that needs taste",
	},
	investigator: {
		provider: "openai",
		id: "gpt-6.1-sol",
		use: "research, web search, code review, audits, investigation, and a second opinion from another model family",
	},
	scout: {
		provider: "openai",
		id: "gpt-6-luna",
		use: "mechanical scouting and fan-out aggregation",
	},
} as const satisfies Aliases;

const panel: ReadonlyArray<keyof typeof aliases> = ["judgment", "investigator"];

export const modelTable: ModelTable = { aliases, panel };
