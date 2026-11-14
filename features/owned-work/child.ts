import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type RunSpec, terminalNameOf } from "../../clients/hc/index.ts";
import type { ChildPi, PiCli, StagedBrief } from "../../clients/pi-cli/index.ts";
import type { SessionAddress } from "../../clients/pi-sessions/index.ts";

/** How deep a chain of agents goes, counting the root as level 1. An agent at the last level has no `delegate` tool. */
export const levels = 3;

export const Role = Schema.Literals(["root", "owner", "leaf"]);

export type Role = typeof Role.Type;

/** The roles a parent can give a delegate: an owner carries one slice and may delegate, a leaf does one bounded task and never does. */
export const ChildRole = Schema.Literals(["owner", "leaf"]);

export type ChildRole = typeof ChildRole.Type;

/** The roles a prompt file fits, from its frontmatter's `for`. */
export const Roles = Role.pipe(Schema.NonEmptyArray);

const Level = Schema.FiniteFromString.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: levels })));

const ChildEnv = Schema.Struct({
	PI_OWNED_WORK_LEVEL: Level,
	PI_OWNED_WORK_ROLE: ChildRole,
	PI_OWNED_WORK_SLICE: Schema.String,
});

export type Self = Data.TaggedEnum<{
	Root: { readonly role: "root"; readonly level: 1 };
	Delegate: { readonly role: ChildRole; readonly level: number; readonly slice: string };
}>;

export const Self = Data.taggedEnum<Self>();

export const selfFromEnv = Effect.fn("selfFromEnv")(function* (env: Readonly<Record<string, string | undefined>>) {
	if (env["PI_OWNED_WORK_LEVEL"] === undefined) {
		return Self.Root({ role: "root", level: 1 });
	}

	const child = yield* Schema.decodeUnknownEffect(ChildEnv)(env);

	return Self.Delegate({
		role: child.PI_OWNED_WORK_ROLE,
		level: child.PI_OWNED_WORK_LEVEL,
		slice: child.PI_OWNED_WORK_SLICE,
	});
});

/** A leaf never delegates, and the level caps how deep an owner's chain goes. */
export const mayDelegate = (self: Self) => self.role !== "leaf" && self.level < levels;

/** `choom -n` sets the OOM score adjustment, so deeper levels die first when memory runs out. */
export const atLevel = ({ level, role }: { readonly level: number; readonly role: ChildRole }) => ({
	oomScoreAdj: String(500 * (level - 1)),
	env: { PI_OWNED_WORK_LEVEL: String(level), PI_OWNED_WORK_ROLE: role },
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

interface BriefCommon extends Omit<ChildPi, "session" | "brief"> {
	/** The user's goal: the call's, else the caller's own. */
	readonly goal: string;
	/** The work's state folder: the call's, else the caller's own, else the root's state label. */
	readonly state: Option.Option<string>;
	/** `facts.md` in the state folder, as read at the call. */
	readonly facts: Option.Option<string>;
	/** The file the caller named and its text, read at the call. Only the text is staged, so a later edit never reaches the child. */
	readonly instructions: Option.Option<{ readonly file: string; readonly text: string }>;
}

/** A leaf's brief has no room for owner rules, so a leaf never receives them. */
export type Brief =
	| (BriefCommon & {
			readonly role: "owner";
			/** `owner.md` in the state folder, as read at the call. */
			readonly ownerRules: Option.Option<string>;
	  })
	| (BriefCommon & { readonly role: "leaf"; readonly ownerRules?: never });

/** What the child reads of its brief: the instructions' text without their file. */
export const stagedOf = (brief: Brief): StagedBrief => {
	const common = {
		goal: brief.goal,
		state: brief.state,
		facts: brief.facts,
		instructions: Option.map(brief.instructions, ({ text }) => text),
	};

	if (brief.role === "owner") {
		return { role: "owner", ...common, ownerRules: brief.ownerRules };
	}

	return { role: "leaf", ...common };
};

export interface LaunchRequest {
	readonly brief: Brief;
	readonly level: number;
	readonly childSession: ChildSession;
	readonly passEnv: Readonly<Record<string, string>>;
}

export const launch = (cli: (typeof PiCli)["Service"]) => (request: LaunchRequest) => {
	const { oomScoreAdj, env } = atLevel({ level: request.level, role: request.brief.role });

	return Effect.map(
		cli.launch({ ...request.brief, session: request.childSession, brief: stagedOf(request.brief) }),
		(argv): Pick<RunSpec, "name" | "argv" | "env"> => ({
			name: terminalNameOf(request.brief.name),
			argv: ["choom", "-n", oomScoreAdj, "--", ...argv],
			env: { ...request.passEnv, ...env },
		}),
	);
};
