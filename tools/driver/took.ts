/** Confirms, before `play` runs, that the root's pi runs on everything the run asked of it. */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schedule from "effect/Schedule";
import type * as Schema from "effect/Schema";

import { type ScenarioFailed, SetupFailed } from "./failed.ts";
import { isJsonArray, type Loaded } from "./probe.ts";
import type { Sessions } from "./sessions.ts";
import type { Setup } from "./setup.ts";

/** What the run asks of the root's pi. */
export interface Asked {
	readonly model: string;
	readonly contextWindow?: number | undefined;
	/** The scenario's own `models`, before `contextWindow` adds its entry. */
	readonly models?: Setup["models"];
	readonly setup: Setup;
	/** The run's own terminal core. */
	readonly socket: string;
}

/**
 * The settings fields the probe's record confirms. pi's own `getCompactionSettings` reads them from the merged settings
 * the probe records, and the run's `compaction` replaces the human's, `modelOverrides` included. pi keeps any other key
 * it reads without a word, so the record shows a key it ignores as taken.
 */
const confirmable = new Set(["compaction.enabled", "compaction.reserveTokens", "compaction.keepRecentTokens"]);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
	Predicate.isObject(value) && !isJsonArray(value);

/** Pure. `key`, or `key.field` for each field when the setting is an object. */
const pathsOf = ([key, value]: readonly [string, Schema.Json]) =>
	isJsonObject(value) ? Arr.map(Rec.toEntries(value), ([field]) => `${key}.${field}`) : [key];

/** Pure. Whether a JSON value sets `contextWindow` at any depth. */
const setsWindow = (value: Schema.Json): boolean => {
	if (isJsonArray(value)) {
		return Arr.some(value, setsWindow);
	}

	return (
		isJsonObject(value) &&
		Arr.some(Rec.toEntries(value), ([key, field]) => key === "contextWindow" || setsWindow(field))
	);
};

/**
 * Pure. Each thing the run asked that the root's pi, by its probe's record, does not run on, or that the record cannot
 * confirm. pi drops a `models.json` it rejects without a word, so a setup with `models` counts any error pi reports
 * for that file. The root's context window is confirmed only as `contextWindow`, so a window in `models` is refused.
 */
export const unmetOf = ({ asked, loaded }: { readonly asked: Asked; readonly loaded: Loaded }) => {
	const window = asked.contextWindow ?? loaded.contextWindow;
	const settings = Rec.toEntries(asked.setup.settings ?? {});
	const unconfirmed = Arr.filter(Arr.flatMap(settings, pathsOf), (path) => !confirmable.has(path));
	const missed = Arr.filter(settings, ([key, value]) => !Equal.equals(loaded.settings[key], value));
	const dropped = asked.setup.models === undefined ? Option.none() : loaded.modelsError;
	const windowInModels = Arr.some(Rec.values(asked.models ?? {}), setsWindow);

	return [
		...(loaded.model === asked.model ? [] : [`it runs ${loaded.model}, not ${asked.model}`]),
		...(loaded.contextWindow === window
			? []
			: [`its context window is ${String(loaded.contextWindow)}, not ${String(window)}`]),
		...Arr.map(Option.toArray(dropped), (error) => `it dropped models.json: ${error}`),
		...Arr.map(missed, ([key]) => `its settings key ${key} is not the one set`),
		...Arr.map(
			unconfirmed,
			(path) => `the driver cannot confirm the setting ${path}, only ${Arr.join([...confirmable], ", ")}`,
		),
		...(windowInModels ? ["models sets a context window, which the driver confirms only as contextWindow"] : []),
		...(Option.contains(loaded.socket, asked.socket)
			? []
			: [
					`it starts delegates in ${Option.getOrElse(loaded.socket, () => "no core")}, not the run's ${asked.socket}`,
				]),
	];
};

/** Fails with `SetupFailed`, exit 2, naming each miss, unless the root's pi runs on everything the run asked of it. */
export const tookSetup = Effect.fn("tookSetup")(function* (
	sessions: Effect.Effect<Sessions, ScenarioFailed>,
	asked: Asked,
) {
	const loaded = yield* sessions.pipe(
		Effect.flatMap(({ root }) => Effect.fromOption(root.loaded)),
		Effect.retry(Schedule.spaced("100 millis")),
		Effect.timeoutOrElse({
			duration: "10 seconds",
			orElse: () => Effect.fail(SetupFailed.make({ message: "the root's probe recorded nothing within 10 s" })),
		}),
	);

	const unmet = unmetOf({ asked, loaded });

	return Arr.isReadonlyArrayNonEmpty(unmet)
		? yield* SetupFailed.make({ message: `the root did not take its setup: ${Arr.join(unmet, "; ")}` })
		: undefined;
});
