import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";

/** Each entry of a folder by name, stamped with its size and mtime, so two fingerprints differ where an entry changed. */
export type Fingerprint = ReadonlyMap<string, string>;

/** The state folders agents write through their tools, `~/.local/state/pi-agent/<project>/<work>`, and the files they cite. */
export class StateFolder extends Context.Service<
	StateFolder,
	{
		/** Empty when the folder cannot be listed, and an empty stamp for an entry that cannot be read. */
		readonly fingerprint: (folder: string) => Effect.Effect<Fingerprint>;
		readonly bytes: (path: string) => Effect.Effect<Uint8Array, PlatformError.PlatformError>;
		readonly text: (path: string) => Effect.Effect<string, PlatformError.PlatformError>;
		/** Whether `path` is a regular file now. A path that cannot be read is not. */
		readonly isFile: (path: string) => Effect.Effect<boolean>;
	}
>()("pi-harness/client/state-folder/StateFolder") {}

export const stateFolderLayer: Layer.Layer<StateFolder, never, FileSystem.FileSystem> = Layer.effect(
	StateFolder,
	Effect.map(FileSystem.FileSystem, (fs) =>
		StateFolder.of({
			fingerprint: Effect.fn("fingerprint")(function* (folder: string) {
				const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

				const stamps = yield* Effect.forEach(names, (name) =>
					fs.stat(`${folder}/${name}`).pipe(
						Effect.map((info) => {
							const mtime = Option.getOrUndefined(Option.map(info.mtime, (date) => date.getTime()));

							return `${String(info.size)} ${String(mtime)}`;
						}),
						Effect.orElseSucceed(() => ""),
						Effect.map((stamp) => [name, stamp] as const),
					),
				);

				return new Map(stamps);
			}),
			bytes: (path) => fs.readFile(path),
			text: (path) => fs.readFileString(path),
			isFile: (path) =>
				fs.stat(path).pipe(
					Effect.map(({ type }) => type === "File"),
					Effect.orElseSucceed(() => false),
				),
		}),
	),
);
