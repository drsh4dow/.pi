/** Confirms, before `play` runs, that the root's pi runs on everything the run asked of it. */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schedule from "effect/Schedule";

import { type ScenarioFailed, SetupFailed } from "./failed.ts";
import type { Loaded } from "./probe.ts";
import type { Sessions } from "./sessions.ts";
import type { Setup } from "./setup.ts";

/** What the run asks of the root's pi. */
export interface Asked {
	readonly model: string;
	readonly contextWindow?: number | undefined;
	readonly setup: Setup;
	/** The run's own terminal core. */
	readonly socket: string;
}

/**
 * Pure. Each thing the run asked that the root's pi, by its probe's record, does not run on. pi drops a `models.json` it
 * rejects without a word, so a setup with `models` counts any error pi reports for that file.
 */
export const unmetOf = ({ asked, loaded }: { readonly asked: Asked; readonly loaded: Loaded }) => {
	const window = asked.contextWindow ?? loaded.contextWindow;
	const settings = Rec.toEntries(asked.setup.settings ?? {});
	const missed = Arr.filter(settings, ([key, value]) => !Equal.equals(loaded.settings[key], value));
	const dropped = asked.setup.models === undefined ? Option.none() : loaded.modelsError;

	return [
		...(loaded.model === asked.model ? [] : [`it runs ${loaded.model}, not ${asked.model}`]),
		...(loaded.contextWindow === window
			? []
			: [`its context window is ${String(loaded.contextWindow)}, not ${String(window)}`]),
		...Arr.map(Option.toArray(dropped), (error) => `it dropped models.json: ${error}`),
		...Arr.map(missed, ([key]) => `its settings key ${key} is not the one set`),
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
