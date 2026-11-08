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

/** What the child pi runs with. */
export interface Loadout {
	readonly model: string;
	/** Added after pi's base system prompt, the SYSTEM.md pi finds, so the child keeps it. */
	readonly systemPrompt: string;
	/** Tool names the child declares, such as `read`, `bash`, `codemode`. */
	readonly tools: ReadonlyArray<string>;
	readonly extensions?: ReadonlyArray<string>;
	readonly skills?: ReadonlyArray<string>;
	readonly contextFiles?: boolean;
}

export interface ChildPi {
	/** Give each child a fresh uuid as `id`, because pi reuses an existing session with the same id. */
	readonly session: SessionAddress;
	readonly name: string;
	readonly message: string;
	readonly loadout: Loadout;
}

export class PiCli extends Context.Service<
	PiCli,
	{
		/** Stages the message and system prompt beside the child's session and returns the argv that starts the child. */
		readonly launch: (
			child: ChildPi,
		) => Effect.Effect<readonly [string, ...Array<string>], PlatformError.PlatformError>;
		readonly unstage: (session: SessionAddress) => Effect.Effect<void>;
	}
>()("pi-harness/clients/pi-cli/PiCli") {}

const coreTools = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/** Tools that come from a built-in extension, which `--no-extensions` drops unless `-e` names it again. */
const builtinExtensions = [
	{ tool: "codemode", extension: "builtin:codemode" },
	{ tool: "tool_search", extension: "builtin:tool-search" },
];

const flagEach = (flag: string, values: ReadonlyArray<string>) => Arr.flatMap(values, (value) => [flag, value]);

const listFlag = (flag: string, values: ReadonlyArray<string>) =>
	Arr.isReadonlyArrayNonEmpty(values) ? [flag, Arr.join(values, ",")] : [];

/**
 * Never a plain `--tools a,b` allowlist: it would unregister the child extensions' own tools in the child. `+name` on a
 * tool already on is a no-op, so every listed tool gets one, whatever the user's `defaultTools`.
 */
const loadoutFlags = (childExtensions: ReadonlyArray<string>, loadout: Loadout) => {
	const extensions = Arr.flatMap(builtinExtensions, ({ tool, extension }) =>
		loadout.tools.includes(tool) ? [extension] : [],
	);

	return [
		"--no-extensions",
		...flagEach("-e", [...childExtensions, ...extensions, ...(loadout.extensions ?? [])]),
		"--no-skills",
		...flagEach("--skill", loadout.skills ?? []),
		...(loadout.contextFiles === true ? [] : ["--no-context-files"]),
		...listFlag("--exclude-tools", Arr.difference(coreTools, loadout.tools)),
		...listFlag(
			"--tools",
			Arr.map(loadout.tools, (tool) => `+${tool}`),
		),
	];
};

/**
 * One argv word holds at most 128 KiB, so the message and the system prompt go in files beside the child's session.
 * pi reads `@message` as an included file and `--append-system-prompt` as a path when the file exists.
 */
const stagedFiles = ({ dir, id }: Pick<SessionAddress, "dir" | "id">) => ({
	message: `${dir}/${id}.message`,
	prompt: `${dir}/${id}.prompt`,
});

const argvOf = (
	childExtensions: ReadonlyArray<string>,
	{ session, name, loadout }: ChildPi,
	files: ReturnType<typeof stagedFiles>,
) =>
	[
		"pi",
		"--model",
		loadout.model,
		"--append-system-prompt",
		files.prompt,
		"--session-id",
		session.id,
		"--session-dir",
		session.dir,
		"--name",
		name,
		...loadoutFlags(childExtensions, loadout),
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

					return Effect.all([
						fs.makeDirectory(child.session.dir, { recursive: true }),
						Effect.sync(() => staged.add(files.message).add(files.prompt)),
						fs.writeFileString(files.message, child.message),
						fs.writeFileString(files.prompt, child.loadout.systemPrompt),
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
