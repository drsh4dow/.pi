import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";

/** The PHI router's lane log, one JSONL file per session under `$HOME/.local/state/pi-phi-router/lanes`. */
export class LaneLog extends Context.Service<
	LaneLog,
	{
		/** Appends `json` and a newline to the session's file, making the folder first. HOME is read on every call. */
		readonly append: (line: {
			readonly session: string;
			readonly json: string;
		}) => Effect.Effect<void, PlatformError.PlatformError | Config.ConfigError>;
	}
>()("pi-harness/client/phi-lane-log/LaneLog") {}

export const laneLogLayer: Layer.Layer<LaneLog, never, FileSystem.FileSystem> = Layer.effect(
	LaneLog,
	Effect.map(FileSystem.FileSystem, (fs) =>
		LaneLog.of({
			append: ({ session, json }) =>
				Effect.gen(function* () {
					const home = yield* Config.String("HOME");
					const folder = `${home}/.local/state/pi-phi-router/lanes`;

					yield* fs.makeDirectory(folder, { recursive: true });
					yield* fs.writeFileString(`${folder}/${session}.jsonl`, `${json}\n`, { flag: "a" });
				}),
		}),
	),
);
