import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Str from "effect/String";

/**
 * The whole lines appended since an offset. The last line may still be half written, so reading stops at the last
 * newline. A file shorter than what was read was replaced, so it is read again from the start.
 */
export interface Appended {
	readonly replaced: boolean;
	readonly text: string;
	/** Where the next read starts. */
	readonly offset: number;
}

const newline = 10;

export const appendedLines = ({
	path,
	offset,
}: {
	readonly path: string;
	readonly offset: number;
}): Effect.Effect<Option.Option<Appended>, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		if (!(yield* fs.exists(path))) {
			return Option.none();
		}

		const size = Number((yield* fs.stat(path)).size);
		const replaced = size < offset;
		const from = replaced ? 0 : offset;

		const bytes = yield* Effect.scoped(
			Effect.flatMap(fs.open(path), (file) => file.readAlloc(size - from, { position: BigInt(from) })),
		);

		const appended = Option.getOrElse(bytes, () => new Uint8Array());
		const end = appended.lastIndexOf(newline) + 1;

		return Option.some({ replaced, text: new TextDecoder().decode(appended.subarray(0, end)), offset: from + end });
	});

export const sessionFileById = ({
	dir,
	id,
}: {
	readonly dir: string;
	readonly id: string;
}): Effect.Effect<Option.Option<string>, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		if (!(yield* fs.exists(dir))) {
			return Option.none();
		}

		const names = yield* fs.readDirectory(dir);

		return Option.map(Arr.findFirst(names, Str.endsWith(`_${id}.jsonl`)), (name) => `${dir}/${name}`);
	});
