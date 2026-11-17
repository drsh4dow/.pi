import { uuidv7 } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";

/** Stamps the source files that lay out a value, so a reload can tell whether the code that wrote it changed. */
export class SourceStamp extends Context.Service<
	SourceStamp,
	{
		/** A hash of the files' text. An unreadable file gives a stamp no other call shares. */
		readonly of: (files: ReadonlyArray<string>) => Effect.Effect<number>;
	}
>()("pi-harness/client/source-stamp/SourceStamp") {}

export const sourceStampLayer: Layer.Layer<SourceStamp, never, FileSystem.FileSystem> = Layer.effect(
	SourceStamp,
	Effect.map(FileSystem.FileSystem, (fs) =>
		SourceStamp.of({
			of: (files) =>
				Effect.forEach(files, (file) => fs.readFileString(file)).pipe(
					Effect.map((texts) => Hash.string(Arr.join(texts, "\n"))),
					Effect.orElseSucceed(() => Hash.string(uuidv7())),
				),
		}),
	),
);
