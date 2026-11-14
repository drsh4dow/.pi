/** The run's `settings.json` and `models.json`, from the human's and what the scenario sets. Pure. */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const resourceKeys = new Set(["packages", "extensions", "skills", "prompts", "themes"]);

const replaced = (_theirs: Schema.Json, ours: Schema.Json) => ours;

/**
 * Pure. The run's `settings.json`: the human's without the resource keys, which could load the live harness into the
 * run, and with the setup's top-level keys replacing theirs.
 */
export const settingsOf = (input: {
	readonly human: Schema.JsonObject;
	readonly overrides: Schema.JsonObject;
}): Schema.JsonObject =>
	Rec.union(
		Rec.filter(input.human, (_value, key) => !resourceKeys.has(key)),
		input.overrides,
		replaced,
	);

const isJsonObject = Schema.is(Schema.JsonObject);

/** Pure. The run's `models.json`: the human's (or none), with each setup provider replacing the human's of that name. */
export const modelsOf = (input: {
	readonly human: Option.Option<Schema.JsonObject>;
	readonly providers: Readonly<Record<string, Schema.JsonObject>>;
}): Schema.JsonObject => {
	const theirs = Option.getOrElse(input.human, (): Schema.JsonObject => ({}));
	const theirProviders = Option.filter(Option.fromUndefinedOr(theirs["providers"]), isJsonObject);

	const providers = Rec.union(
		Option.getOrElse(theirProviders, () => ({})),
		input.providers,
		replaced,
	);

	return Rec.union(theirs, { providers }, replaced);
};

/** What a scenario changes about the run's world before the root starts. */
export interface Setup {
	/** Top-level keys that replace the same keys in the run's copy of the human's `settings.json`. */
	readonly settings?: Schema.JsonObject;
	/**
	 * Provider entries by name, shaped like `models.json`'s `providers` values (`modelOverrides` included). Each replaces
	 * the human's entry of that name in the run's copy of their `models.json`, or starts the file when they have none.
	 */
	readonly models?: Readonly<Record<string, Schema.JsonObject>>;
}

/** Pure. A scenario's setup, with `contextWindow` turned into the compaction settings and the model entry it stands for. */
export const setupOf = (spec: Setup & { readonly model: string; readonly contextWindow?: number }): Setup => {
	if (spec.contextWindow === undefined) {
		return spec;
	}

	const [provider, ...id] = Str.split(spec.model, "/");
	const window = spec.contextWindow;

	const compaction = {
		enabled: true,
		reserveTokens: Math.floor(window / 4),
		keepRecentTokens: Math.floor(window / 8),
	};

	const entry: Schema.JsonObject = { modelOverrides: { [Arr.join(id, "/")]: { contextWindow: window } } };

	return {
		settings: Rec.union({ compaction }, spec.settings ?? {}, replaced),
		models: Rec.union({ [provider]: entry }, spec.models ?? {}, (_ours, theirs: Schema.JsonObject) => theirs),
	};
};
