import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { SessionAddress } from "../pi-sessions/index.ts";

const briefFields = {
	goal: Schema.String,
	state: Schema.OptionFromOptionalKey(Schema.String),
	facts: Schema.OptionFromOptionalKey(Schema.String),
	instructions: Schema.OptionFromOptionalKey(Schema.String),
};

export const StagedBrief = Schema.Union([
	Schema.Struct({
		role: Schema.Literal("owner"),
		...briefFields,
		ownerRules: Schema.OptionFromOptionalKey(Schema.String),
	}),
	Schema.Struct({ role: Schema.Literal("leaf"), ...briefFields }),
]);

export type StagedBrief = typeof StagedBrief.Type;

const BriefJson = Schema.fromJsonString(StagedBrief);

const encodeBrief = (brief: StagedBrief) => Effect.orDie(Schema.encodeEffect(BriefJson)(brief));

export interface ChildPi {
	readonly session: SessionAddress;
	readonly name: string;
	readonly message: string;
	readonly model: string;
	readonly thinking: Option.Option<string>;
	readonly readOnly: boolean;
	readonly brief: StagedBrief;
}

export class PiCli extends Context.Service<
	PiCli,
	{
		readonly launch: (
			child: ChildPi,
		) => Effect.Effect<readonly [string, ...Array<string>], PlatformError.PlatformError>;
		readonly unstage: (session: SessionAddress) => Effect.Effect<void>;
		/** Leaves every staged file on disk when this layer closes, because a running child reads its brief each turn. */
		readonly release: Effect.Effect<void>;
		/** Takes over the staged files of children that a released layer started, so closing this one removes them. */
		readonly adopt: (sessions: ReadonlyArray<SessionAddress>) => Effect.Effect<void>;
	}
>()("pi-harness/clients/pi-cli/PiCli") {}

/** One argv word holds at most 128 KiB, so the message goes in a file beside the child's session. */
const stagedFiles = ({ dir, id }: Pick<SessionAddress, "dir" | "id">) => ({
	message: `${dir}/${id}.message`,
	brief: `${dir}/${id}.brief.json`,
});

const ownerOnly = 0o600;

const argvOf = (
	childExtensions: ReadonlyArray<string>,
	{ session, name, model, thinking, readOnly }: ChildPi,
	files: ReturnType<typeof stagedFiles>,
) =>
	[
		"pi",
		"--model",
		model,
		...Arr.flatMap(Option.toArray(thinking), (level) => ["--thinking", level]),
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
						Effect.sync(() => staged.add(files.message).add(files.brief)),
						write(files.message, child.message),
						Effect.flatMap(encodeBrief(child.brief), (json) => write(files.brief, json)),
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

							staged.add(files.message).add(files.brief);
						}
					}),
			});
		}),
	);

export class BriefUnreadable extends Schema.TaggedError<BriefUnreadable, { readonly brand: unique symbol }>()(
	"BriefUnreadable",
	{ file: Schema.String, why: Schema.String },
) {}

export const readStagedBrief = Effect.fn("readStagedBrief")(function* (session: Pick<SessionAddress, "dir" | "id">) {
	const fs = yield* FileSystem.FileSystem;
	const file = stagedFiles(session).brief;

	const json = yield* Effect.mapError(fs.readFileString(file), (error) =>
		BriefUnreadable.make({ file, why: error.reason._tag }),
	);

	return yield* Effect.mapError(Schema.decodeEffect(BriefJson)(json), (error) =>
		BriefUnreadable.make({ file, why: error.message }),
	);
});

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
