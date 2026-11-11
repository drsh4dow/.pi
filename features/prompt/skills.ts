import type { Skill } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Function from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const rule = `Skills are workflows, not suggestions.

Load: before you start, read in full every skill below with even a small chance of applying, and the files it points to. Load each skill once unless it has left your context. When a skill's trigger starts to match mid-task or after, load it then and rework what it covers.

Run: a loaded skill runs when its trigger matches your task and none of its exclusions do. A running skill is non-negotiable:
- Run every step, in order. A step ends when its completion criterion holds. The skill ends when its verification checklist, if it has one, passes with evidence.
- Apply every rule in its reference sections.
- When your reason to skip a step is in its rationalizations table, run the step.
- When several skills run, take them in lifecycle order: define, plan, build, verify, review, ship.

Everything else in this prompt outranks a skill. Two cases come up most:
- A step that asks the user follows your role's collaboration rules. As a delegate, return what is missing as your answer.
- A step that publishes, sends a message, or rewrites shared history waits for the authorization your role requires. Until then, prepare it and name it.

These reasons never stop a matched skill:
- "The task is small." A small task runs the same steps, only faster.
- "I know what this skill says." The description is not the workflow. Read the file.
- "The user is in a hurry." Time pressure is a scope question. Surface it.
- "I already did this step." Then recording its result is quick.

Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.`;

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
