import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Function from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { Role, Roles } from "../owned-work/index.ts";
import type { Problem } from "./principles.ts";

/** The one key of a skill's frontmatter the prompt reads. pi reads the rest. */
const Audience = Schema.Struct({ for: Schema.optionalKey(Roles) });

const decodeAudience = Schema.decodeUnknownEffect(Audience);

const rolesOf = Effect.fn("rolesOf")(function* (filePath: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(filePath);
	const { frontmatter } = yield* Effect.try({ try: () => parseFrontmatter(text), catch: String });
	const fields = yield* decodeAudience(frontmatter);
	const roles: ReadonlyArray<Role> = fields.for ?? Role.literals;

	return roles;
});

/** The skills `role` may load: each whose frontmatter `for` names the role, every role when absent. A broken file is left out and reported. */
export const skillsFor = <Found extends Pick<Skill, "filePath">>({
	role,
	skills,
}: {
	role: Role;
	skills: ReadonlyArray<Found>;
}) =>
	Effect.gen(function* () {
		const [fitting, problems] = yield* Effect.partition(skills, (skill) =>
			rolesOf(skill.filePath).pipe(
				Effect.mapBoth({
					onSuccess: (roles) => (roles.includes(role) ? [skill] : []),
					onFailure: (error): Problem => ({ file: skill.filePath, why: String(error) }),
				}),
			),
		);

		return { skills: Arr.flatten(fitting), problems };
	});

const rule = `Skills are workflows, not suggestions.

Load: before you start, read in full every skill below with even a small chance of applying, and the files it points to, once per context. When a trigger matches later, load its skill then and rework what it covers.

Run: a loaded skill is binding when its trigger matches and no exclusion does. Run every step in order, each to its completion criterion, and apply every reference rule. It is done when its verification checklist passes with evidence. An excuse its rationalizations table names means run the step. Several skills run in lifecycle order: define, plan, build, verify, review, ship.

Rank: the rest of this prompt outranks a skill. A step that asks the user follows your role, so a delegate returns the gap as its answer. A step that publishes, messages, or rewrites shared history waits for the authorization your role requires. A step your role rules out, such as a delegate's unrequested commit, is done once your answer names it.

No reason to skip: a small task, a familiar skill (the description is not the workflow), hurry, or a step already done (record its result).

Relative paths in a skill resolve against its directory. Tool calls take absolute paths.`;

const escapeXml = Function.flow(
	Str.replaceAll("&", "&amp;"),
	Str.replaceAll("<", "&lt;"),
	Str.replaceAll(">", "&gt;"),
	Str.replaceAll('"', "&quot;"),
	Str.replaceAll("'", "&apos;"),
);

type Listed = Pick<Skill, "name" | "description" | "filePath" | "disableModelInvocation">;

const entry = ({ name, description, filePath }: Listed) =>
	`  <skill>\n    <name>${escapeXml(name)}</name>\n    <description>${escapeXml(description)}</description>\n    <location>${escapeXml(filePath)}</location>\n  </skill>`;

/** The `<skills>` section, in place of pi's: the rule for loading and running skills, then each skill the model may invoke. */
export const skillsSection = (skills: ReadonlyArray<Listed>) => {
	const shown = Arr.filter(skills, (skill) => !skill.disableModelInvocation);

	return Arr.isReadonlyArrayNonEmpty(shown)
		? Option.some(`${rule}\n\n<available_skills>\n${Arr.join(Arr.map(shown, entry), "\n")}\n</available_skills>`)
		: Option.none();
};
