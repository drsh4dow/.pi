import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Rec from "effect/Record";
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
	readonly aliases: Readonly<Record<string, string>>;
	readonly panel: ReadonlyArray<string>;
}

type Aliases = Readonly<Record<string, ModelKey> & Record<ModelKey, never>>;

const panelByProvider = { anthropic: "claude-opus-5-5", openai: "gpt-6.1-sol" };

export const modelTable: ModelTable = {
	aliases: {
		worker: "anthropic/claude-haiku-5-5",
		judgment: "anthropic/claude-opus-5-5",
	} satisfies Aliases,
	panel: Arr.map(Rec.toEntries(panelByProvider), ([provider, id]) => `${provider}/${id}`),
};
