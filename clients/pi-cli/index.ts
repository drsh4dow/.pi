import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import type { SessionAddress } from "../pi-sessions/index.ts";

export interface ChildPi {
	/** Give each child a fresh uuid as `id`, because pi reuses an existing session with the same id. */
	readonly session: SessionAddress;
	readonly name: string;
	readonly message: string;
	/** `provider/id`. */
	readonly model: string;
	/** The `--thinking` level the child runs at. None leaves pi's default for the model. */
	readonly thinking: Option.Option<string>;
	/** Starts the child without the `edit` and `write` tools. Its bash can still write. */
	readonly readOnly: boolean;
	/** The child's `<instructions>`. Its prompt extension reads them from the file `instructionsFlag` names. */
	readonly instructions: Option.Option<{ readonly text: string }>;
}

export class PiCli extends Context.Service<
	PiCli,
	{
		/** Stages the message, and the instructions when there are any, beside the child's session and returns the argv that starts the child. */
		readonly launch: (
			child: ChildPi,
		) => Effect.Effect<readonly [string, ...Array<string>], PlatformError.PlatformError>;
		readonly unstage: (session: SessionAddress) => Effect.Effect<void>;
	}
>()("pi-harness/clients/pi-cli/PiCli") {}

/** The child's flag for its instructions file, registered by the prompt extension every child loads. */
export const instructionsFlag = "instructions";

/**
 * One argv word holds at most 128 KiB, so the message and the instructions go in files beside the child's session.
 * pi reads `@message` as an included file. The prompt extension reads the instructions file itself.
 */
const stagedFiles = ({ dir, id }: Pick<SessionAddress, "dir" | "id">) => ({
	message: `${dir}/${id}.message`,
	instructions: `${dir}/${id}.instructions`,
});

/** A task message or prompt can hold what the parent read behind a token. */
const ownerOnly = 0o600;

/**
 * The child keeps pi's default tools, the tools its extensions register, and codemode, which `--no-extensions` drops
 * until `-e builtin:codemode` loads it again.
 */
const argvOf = (
	childExtensions: ReadonlyArray<string>,
	{ session, name, model, thinking, readOnly, instructions }: ChildPi,
	files: ReturnType<typeof stagedFiles>,
) =>
	[
		"pi",
		"--model",
		model,
		...Arr.flatMap(Option.toArray(thinking), (level) => ["--thinking", level]),
		...(Option.isSome(instructions) ? [`--${instructionsFlag}`, files.instructions] : []),
		"--session-id",
		session.id,
		"--session-dir",
		session.dir,
		"--name",
		name,
		"--no-extensions",
		...Arr.flatMap([...childExtensions, "builtin:codemode"], (extension) => ["-e", extension]),
		"--no-context-files",
		"--tools",
		"+codemode",
		...(readOnly ? ["--exclude-tools", "edit,write"] : []),
		"--",
		`@${files.message}`,
	] as const;

/** `childExtensions` are the extensions every child loads first, each with `-e`. */
export const piCliLayer = (childExtensions: ReadonlyArray<string>): Layer.Layer<PiCli, never, FileSystem.FileSystem> =>
	Layer.effect(
		PiCli,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const staged = new Set<string>();

			const forget = (file: string) => Effect.sync(() => staged.delete(file));

			const remove = (files: Iterable<string>) =>
				Effect.forEach(files, (file) => Effect.andThen(forget(file), fs.remove(file, { force: true }))).pipe(
					Effect.ignore({ log: "Warn" }),
				);

			yield* Effect.addFinalizer(() => remove(staged));

			return PiCli.of({
				launch: (child) => {
					const files = stagedFiles(child.session);
					const write = (file: string, text: string) => fs.writeFileString(file, text, { mode: ownerOnly });

					return Effect.all([
						fs.makeDirectory(child.session.dir, { recursive: true, mode: 0o700 }),
						fs.chmod(child.session.dir, 0o700),
						Effect.sync(() => staged.add(files.message).add(files.instructions)),
						write(files.message, child.message),
						...Option.toArray(Option.map(child.instructions, ({ text }) => write(files.instructions, text))),
					]).pipe(Effect.as(argvOf(childExtensions, child, files)));
				},
				unstage: (session) => remove(Rec.values(stagedFiles(session))),
			});
		}),
	);

/** An `@file` argument reaches the prompt as `<file name="path">` text (pi's `cli/file-processor.js`), so this takes the message back out. */
export const unwrapMessage =
	(session: Pick<SessionAddress, "dir" | "id">) =>
	(input: string): Option.Option<string> => {
		const opening = `<file name="${stagedFiles(session).message}">\n`;
		const closing = "\n</file>\n";

		return Str.startsWith(opening)(input) && Str.endsWith(closing)(input)
			? Option.some(Str.slice(opening.length, -closing.length)(input))
			: Option.none();
	};
