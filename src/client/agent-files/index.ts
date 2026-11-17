import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Str from "effect/String";

/** One `<name>.md` directly in a folder. */
export interface MarkdownFile {
	readonly name: string;
	readonly path: string;
}

/** The text of a role file or a guide, wherever pi found it, as the file reads now. */
export const agentFileText = Effect.fn("agentFileText")(function* (path: string) {
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.readFileString(path);
});

/** Every `<name>.md` directly in `dir`, in directory order, none when `dir` is missing. Files in its subfolders are left out. */
export const markdownIn = Effect.fn("markdownIn")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const names = (yield* fs.exists(dir)) ? yield* fs.readDirectory(dir) : [];

	return Arr.map(Arr.filter(names, Str.endsWith(".md")), (name): MarkdownFile => ({
		name: Str.slice(0, -3)(name),
		path: `${dir}/${name}`,
	}));
});
