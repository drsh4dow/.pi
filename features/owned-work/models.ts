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

export interface ModelTable {
	/** A model id for each alias. An alias runs on the caller's provider when that provider has the model, so a delegate stays on its parent's account, and on `fallbackProvider` otherwise. */
	readonly aliases: Readonly<Record<string, string>>;
	readonly fallbackProvider: string;
	/** Model names, aliases or `provider/id`, one per provider. */
	readonly panel: ReadonlyArray<string>;
}

/** An alias never looks like a `provider/id`, so a spelled model always means that model. */
type Aliases = Readonly<Record<string, string> & Record<ModelKey, never>>;

const aliases = {
	worker: "claude-haiku-5-5",
	judgment: "claude-opus-5-5",
} as const satisfies Aliases;

const claudeJudgment: keyof typeof aliases = "judgment";

export const modelTable: ModelTable = {
	aliases,
	fallbackProvider: "ultra-a",
	panel: [claudeJudgment, "openai/gpt-6.1-sol"],
};
