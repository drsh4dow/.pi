import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type RunSpec, terminalNameOf } from "../../clients/hc/index.ts";
import type { ChildPi, PiCli } from "../../clients/pi-cli/index.ts";
import type { SessionAddress } from "../../clients/pi-sessions/index.ts";

/** How deep a chain of agents goes, counting the root as level 1. An agent at the last level has no `delegate` tool. */
export const levels = 3;

export const Role = Schema.Literals(["root", "delegate"]);

export type Role = typeof Role.Type;

/** The roles a prompt file fits, from its frontmatter's `for`. */
export const Roles = Role.pipe(Schema.NonEmptyArray);

const Level = Schema.FiniteFromString.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: levels })));

const ChildEnv = Schema.Struct({ PI_OWNED_WORK_LEVEL: Level, PI_OWNED_WORK_SLICE: Schema.String });

export type Self = Data.TaggedEnum<{
	Root: { readonly role: "root"; readonly level: 1 };
	Delegate: { readonly role: "delegate"; readonly level: number; readonly slice: string };
}>;

export const Self = Data.taggedEnum<Self>();

export const selfFromEnv = Effect.fn("selfFromEnv")(function* (env: Readonly<Record<string, string | undefined>>) {
	if (env["PI_OWNED_WORK_LEVEL"] === undefined) {
		return Self.Root({ role: "root", level: 1 });
	}

	const child = yield* Schema.decodeUnknownEffect(ChildEnv)(env);

	return Self.Delegate({ role: "delegate", level: child.PI_OWNED_WORK_LEVEL, slice: child.PI_OWNED_WORK_SLICE });
});

/** `choom -n` sets the OOM score adjustment, so deeper levels die first when memory runs out. */
export const atLevel = (level: number) => ({
	oomScoreAdj: String(500 * (level - 1)),
	env: { PI_OWNED_WORK_LEVEL: String(level) },
});

export const inheritedEnv = (env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> =>
	Rec.filterMap(env, (value, key) =>
		value === undefined || /^HC_TERMINAL_|^PI_OWNED_WORK_/u.test(key) ? Result.failVoid : Result.succeed(value),
	);

/** `dir` is the `delegates/` subfolder of the root's session folder, so `pi -c` never picks a child. */
export type ChildSession = SessionAddress;

const extensionsFolder = `${import.meta.dirname}/../../agent/extensions`;

/**
 * The entrypoints every delegate loads first: owned-work, so it can report back, prompt, which builds its system prompt,
 * web, so every agent can search and read pages, and claude-accounts, so a delegate can run on its parent's Claude account.
 */
export const childExtensions: ReadonlyArray<string> = [
	`${extensionsFolder}/owned-work/index.ts`,
	`${extensionsFolder}/prompt/index.ts`,
	`${extensionsFolder}/web/index.ts`,
	`${extensionsFolder}/claude-accounts/index.ts`,
];

export interface Brief extends Omit<ChildPi, "session"> {
	/** The file the caller named and its text, read at the call. Only the text is staged, so a later edit never reaches the child. */
	readonly instructions: Option.Option<{ readonly file: string; readonly text: string }>;
}

export interface LaunchRequest {
	readonly brief: Brief;
	readonly level: number;
	readonly childSession: ChildSession;
	readonly passEnv: Readonly<Record<string, string>>;
}

export const launch = (cli: (typeof PiCli)["Service"]) => (request: LaunchRequest) => {
	const { oomScoreAdj, env } = atLevel(request.level);

	return Effect.map(
		cli.launch({ ...request.brief, session: request.childSession }),
		(argv): Pick<RunSpec, "name" | "argv" | "env"> => ({
			name: terminalNameOf(request.brief.name),
			argv: ["choom", "-n", oomScoreAdj, "--", ...argv],
			env: { ...request.passEnv, ...env },
		}),
	);
};
