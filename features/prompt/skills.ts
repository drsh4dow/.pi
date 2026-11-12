import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Function from "effect/Function";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { Role, Roles } from "../owned-work/index.ts";
import type { Problem } from "./kinds.ts";

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

Run: a loaded skill is binding when its trigger matches and no exclusion does. Run every step in order, each to its completion criterion, and apply every reference rule. It is done when its verification checklist passes with evidence. An excuse its rationalizations table names means run the step. A playbook's steps name the skills they need.

Rank: the rest of this prompt outranks a skill. A step that asks the user follows your role, so a delegate returns the gap as its answer. A step that publishes, messages, or rewrites shared history waits for the authorization your role requires. A step your role rules out, such as a delegate's unrequested commit, is done once your answer names it.

No reason to skip: a small task, a familiar skill (the description is not the workflow), hurry, or a step already done (record its result).

A skill's file is \`<dir>/<name>/SKILL.md\`, with the \`dir\` its list names, or the path in parentheses after its name. Relative paths in a skill resolve against its directory. Tool calls take absolute paths.`;

type Listed = Pick<Skill, "name" | "description" | "filePath" | "disableModelInvocation">;

const oneLine = Function.flow(Str.replaceAll(/\s+/gu, " "), Str.trim);

/** The skill's line under its folder when its file is `<dir>/<name>/SKILL.md`, or a line naming its file when pi found it elsewhere. */
const located = ({ name, description, filePath }: Listed) => {
	const tail = `/${name}/SKILL.md`;

	return Str.endsWith(tail)(filePath)
		? Result.succeed({ dir: Str.slice(0, -tail.length)(filePath), line: `- ${name}: ${oneLine(description)}` })
		: Result.fail(`- ${name} (${filePath}): ${oneLine(description)}`);
};

const list = (attribute: string, lines: ReadonlyArray<string>) =>
	`<available_skills${attribute}>\n${Arr.join(lines, "\n")}\n</available_skills>`;

/** The `<skills>` section, in place of pi's: the rule for loading and running skills, then each skill the model may invoke, one list per folder. */
export const skillsSection = (skills: ReadonlyArray<Listed>) => {
	const shown = Arr.filter(skills, (skill) => !skill.disableModelInvocation);
	const [placed, unplaced] = Arr.partition(shown, located);

	const folders = Record.map(
		Arr.groupBy(placed, ({ dir }) => dir),
		Arr.map(({ line }) => line),
	);

	const lists = [
		...Arr.map(Record.toEntries(folders), ([dir, lines]) => list(` dir="${dir}"`, lines)),
		...(Arr.isReadonlyArrayNonEmpty(unplaced) ? [list("", unplaced)] : []),
	];

	return Arr.isReadonlyArrayNonEmpty(lists) ? Option.some(`${rule}\n\n${Arr.join(lists, "\n")}`) : Option.none();
};
