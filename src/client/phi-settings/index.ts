import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";

/** The PHI router's settings file, `$HOME/.pi/agent/phi-router.json`, which the user writes and the router only reads. */
export class PhiSettings extends Context.Service<
	PhiSettings,
	{
		/** The file's text, none when it does not exist. HOME and the file are read on every run. */
		readonly text: Effect.Effect<Option.Option<string>, PlatformError.PlatformError | Config.ConfigError>;
	}
>()("pi-harness/client/phi-settings/PhiSettings") {}

/** The client for a caller whose runtime holds only a FileSystem, such as owned-work's. */
export const makePhiSettings: Effect.Effect<PhiSettings["Service"], never, FileSystem.FileSystem> = Effect.map(
	FileSystem.FileSystem,
	(fs) =>
		PhiSettings.of({
			text: Effect.flatMap(Config.String("HOME"), (home) =>
				fs.readFileString(`${home}/.pi/agent/phi-router.json`).pipe(
					Effect.asSome,
					Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
				),
			),
		}),
);

export const phiSettingsLayer: Layer.Layer<PhiSettings, never, FileSystem.FileSystem> = Layer.effect(
	PhiSettings,
	makePhiSettings,
);
