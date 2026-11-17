import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/** `why` is the platform's reason, such as `NotFound`, or `not a folder`. */
class SourceRefused extends Schema.TaggedError<SourceRefused, { readonly brand: unique symbol }>()("SourceRefused", {
	path: Schema.String,
	why: Schema.String,
}) {}

/**
 * The files and folders a delegate's brief is built from: instructions files, state-folder notes, design sketches, and
 * the folders a delegate starts or keeps its state in. Owned-work reads them and never writes them.
 */
export class BriefSources extends Context.Service<
	BriefSources,
	{
		readonly read: (file: string) => Effect.Effect<string, SourceRefused>;
		/** None when the file does not exist. */
		readonly readIfPresent: (file: string) => Effect.Effect<Option.Option<string>, SourceRefused>;
		readonly list: (folder: string) => Effect.Effect<ReadonlyArray<string>, SourceRefused>;
		/** The real path of `folder`, which must exist and be a folder. */
		readonly realFolder: (folder: string) => Effect.Effect<string, SourceRefused>;
	}
>()("pi-harness/client/brief-sources/BriefSources") {}

const refused = (path: string, error: PlatformError.PlatformError): SourceRefused =>
	SourceRefused.make({ path, why: error.reason._tag });

export const briefSourcesLayer: Layer.Layer<BriefSources, never, FileSystem.FileSystem> = Layer.effect(
	BriefSources,
	Effect.map(FileSystem.FileSystem, (fs) =>
		BriefSources.of({
			read: (file) => Effect.mapError(fs.readFileString(file), (error) => refused(file, error)),
			readIfPresent: (file) =>
				fs.readFileString(file).pipe(
					Effect.asSome,
					Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
					Effect.mapError((error) => refused(file, error)),
				),
			list: (folder) => Effect.mapError(fs.readDirectory(folder), (error) => refused(folder, error)),
			realFolder: (folder) =>
				Effect.gen(function* () {
					const real = yield* Effect.mapError(fs.realPath(folder), (error) => refused(folder, error));
					const info = yield* Effect.mapError(fs.stat(real), (error) => refused(folder, error));

					return info.type === "Directory"
						? real
						: yield* SourceRefused.make({ path: folder, why: "not a folder" });
				}),
		}),
	),
);
