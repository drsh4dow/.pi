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
	readonly session: SessionAddress;
	readonly name: string;
	readonly message: string;
	readonly model: string;
	readonly thinking: Option.Option<string>;
	readonly readOnly: boolean;
	readonly instructions: Option.Option<{ readonly text: string }>;
}

export class PiCli extends Context.Service<
	PiCli,
	{
		readonly launch: (
			child: ChildPi,
		) => Effect.Effect<readonly [string, ...Array<string>], PlatformError.PlatformError>;
		readonly unstage: (session: SessionAddress) => Effect.Effect<void>;
		/** Leaves every staged file on disk when this layer closes, because a running child reads its instructions each turn. */
		readonly release: Effect.Effect<void>;
		/** Takes over the staged files of children that a released layer started, so closing this one removes them. */
		readonly adopt: (sessions: ReadonlyArray<SessionAddress>) => Effect.Effect<void>;
	}
>()("pi-harness/clients/pi-cli/PiCli") {}

export const instructionsFlag = "instructions";

/** One argv word holds at most 128 KiB, so the message and the instructions go in files beside the child's session. */
const stagedFiles = ({ dir, id }: Pick<SessionAddress, "dir" | "id">) => ({
	message: `${dir}/${id}.message`,
	instructions: `${dir}/${id}.instructions`,
});

const ownerOnly = 0o600;

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
		...Arr.flatMap([...childExtensions, "builtin:codemode", "builtin:mcp"], (extension) => ["-e", extension]),
		"--no-context-files",
		"--tools",
		"+codemode",
		...(readOnly ? ["--exclude-tools", "edit,write"] : []),
		"--",
		`@${files.message}`,
	] as const;

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
				release: Effect.sync(() => {
					staged.clear();
				}),
				adopt: (sessions) =>
					Effect.sync(() => {
						for (const session of sessions) {
							const files = stagedFiles(session);

							staged.add(files.message).add(files.instructions);
						}
					}),
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
