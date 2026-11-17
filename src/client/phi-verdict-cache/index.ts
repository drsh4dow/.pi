import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Str from "effect/String";

/**
 * One policy version's system verdict cache, as one process sees it. Each process appends only to its own file, and
 * a read merges every process's file.
 */
export interface VerdictCacheFile {
	/** Every line of every process's file. A folder never made holds none. */
	readonly lines: Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>;
	/** Each line starts with a newline, so a line cut short by a crash never swallows the next one. */
	readonly append: (lines: ReadonlyArray<string>) => Effect.Effect<void, PlatformError.PlatformError>;
}

/** The PHI router's system verdict cache, `$HOME/.local/state/pi-phi-router/system/<policy>/<pid>.jsonl`. */
export class VerdictCache extends Context.Service<
	VerdictCache,
	{
		/** HOME is read once, here. */
		readonly open: (at: {
			readonly policy: string;
			readonly pid: number;
		}) => Effect.Effect<VerdictCacheFile, Config.ConfigError>;
	}
>()("pi-harness/client/phi-verdict-cache/VerdictCache") {}

const fileIn = (fs: FileSystem.FileSystem, folder: string, pid: number): VerdictCacheFile => ({
	lines: Effect.gen(function* () {
		const files = yield* fs
			.readDirectory(folder)
			.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));

		const texts = yield* Effect.forEach(files, (file) => fs.readFileString(`${folder}/${file}`));

		return Arr.flatMap(texts, (text) => Str.split(text, "\n"));
	}),
	append: (lines) =>
		Effect.gen(function* () {
			const text = Arr.join(
				Arr.map(lines, (line) => `\n${line}`),
				"",
			);

			yield* fs.makeDirectory(folder, { recursive: true });
			yield* fs.writeFileString(`${folder}/${String(pid)}.jsonl`, text, { flag: "a" });
		}),
});

export const verdictCacheLayer: Layer.Layer<VerdictCache, never, FileSystem.FileSystem> = Layer.effect(
	VerdictCache,
	Effect.map(FileSystem.FileSystem, (fs) =>
		VerdictCache.of({
			open: ({ policy, pid }) =>
				Effect.map(Config.String("HOME"), (home) =>
					fileIn(fs, `${home}/.local/state/pi-phi-router/system/${policy}`, pid),
				),
		}),
	),
);
