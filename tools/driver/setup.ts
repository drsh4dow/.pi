/** The run's `settings.json` and `models.json`, from the human's and what the scenario sets. Pure. */
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";

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
	readonly settings?: Schema.JsonObject;
	readonly models?: Readonly<Record<string, Schema.JsonObject>>;
}
