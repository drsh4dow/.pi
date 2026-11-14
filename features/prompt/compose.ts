import {
	type BeforeAgentStartEvent,
	type NormalizedBuildSystemPromptOptions,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { StagedBrief } from "../../clients/pi-cli/index.ts";
import { skillsSection } from "./skills.ts";

export interface Layers {
	/** The role file: its `<role>` and `<collaboration>` blocks. */
	readonly role: string;
	readonly brief: Option.Option<StagedBrief>;
	/** The `<principles>` index. */
	readonly principles: Option.Option<string>;
	/** The `<playbooks>` index. */
	readonly playbooks: Option.Option<string>;
	/** The skills this agent's role may load. */
	readonly skills: ReadonlyArray<Skill>;
}

const bullets = (lines: ReadonlyArray<string>) =>
	Arr.join(
		Arr.map(lines, (line) => `- ${line}`),
		"\n",
	);

/** Built-in tools whose guidelines restate their own schema description, or `<codemode>` in `SYSTEM.md`. */
const restating = ["edit", "codemode"];

/** The `<rules>` section pi builds for its default prompt, without the rules pi hardcodes. */
const rulesSection = (options: NormalizedBuildSystemPromptOptions) => {
	const declared = Arr.difference(options.selectedTools, options.hiddenTools);
	const guided = Arr.difference(declared, restating);

	const guidelines = [
		...Arr.flatMap(guided, (name) => options.toolGuidelines[name] ?? []),
		...options.promptGuidelines,
	];

	const trimmed = Arr.map(guidelines, Str.trim);
	const rules = Arr.dedupe(Arr.filter(trimmed, Str.isNonEmpty));

	return bullets(rules);
};

/** How an agent uses the playbooks index. It goes out only with the index, so an agent with no playbooks never reads it. */
export const playbooksWorkflow = `<playbooks-workflow>
Playbooks, listed under \`<playbooks>\` as \`name: when\`, are the workflows for each kind of work. A playbook's file is \`<name>.md\` in the \`dir\` that \`<playbooks>\` names, and \`playbooks/<name>.md\` in any skill or playbook is that file.

- Before you act, read the file of every playbook whose \`when\` matches the task. Several can match, and a step can send you to another playbook. When the work changes kind, such as an investigation that turns into a bug fix, read the playbook for the new kind then.
- A playbook is the base of your workflow for that work. Run its steps in order, each to its check, and add what the task needs around them.
- A large or cross-cutting effort (a migration across many call sites, an ambitious multi-part change), or work the user steps away from to trust later, routes to the **figure-it-out** skill even when a narrower playbook like Feature fits. Use **figure-it-out** whenever no playbook fits work that needs a process. It designs a bespoke, rigorous playbook for the task. A standing project-scale program (multi-day, many stacked PRs, a fleet of delegates under one coordinator) routes to \`playbooks/orchestrate.md\` instead. A chore, a quick question, or a fully specified small edit needs no playbook.
- When your role keeps a \`TODO.md\`, it is the record of your playbooks. On reading one, add \`## <playbook name>\` and a line per numbered step, \`- [ ] <n>. <the step's opening sentence>\`. Your own items go under \`## task\`. Mark a step \`- [x]\` once its check passes, or \`- [-]\` with \`skip: <reason>\` after the sentence when you do not run it as written. Before your final reply, mark every step you finished or passed over, so a line still open is work that goes on.
- End with the reply the playbook asks for. Before you send it, walk the playbook's numbered steps, and give each step you did not run as written a one-line \`skip: <reason>\` that names the step, taken from \`TODO.md\` when you keep one.
</playbooks-workflow>`;

const block = (tag: string, body: string) => `<${tag}>\n${Str.trim(body)}\n</${tag}>`;

export const briefBlocks = (brief: StagedBrief): string => {
	const workLines = [
		`The user's goal: ${Str.trim(brief.goal)}`,
		...Option.toArray(Option.map(brief.state, (state) => `The work's state folder: ${Str.trim(state)}`)),
	];

	const ownerRules = brief.role === "owner" ? brief.ownerRules : Option.none();

	const blocks = [
		block("work", Arr.join(workLines, "\n")),
		...Option.toArray(Option.map(brief.facts, (facts) => block("project-facts", facts))),
		...Option.toArray(Option.map(ownerRules, (rules) => block("owner-rules", rules))),
		...Option.toArray(Option.map(brief.instructions, (text) => block("instructions", text))),
	];

	return Arr.join(blocks, "\n\n");
};

/**
 * Writes `SYSTEM.md`, the role file, the delegate's brief and the principles and playbooks indexes into pi's
 * preamble, so they render before `<project_context>`. A custom preamble makes pi drop its `<tools>`, `<rules>` and `<docs>`. This adds
 * back `<rules>` as a custom section, which pi renders last. It leaves `<tools>` out, since each tool's schema already
 * describes it, and `<docs>`, which only work on this harness needs and its `AGENTS.md` carries. The `<skills>` section
 * replaces pi's own in place. pi builds fresh options for each run, so running this again never stacks.
 */
export const compose = (layers: Layers) => (event: BeforeAgentStartEvent) => {
	const options = event.systemPromptOptions;

	const parts = [
		options.customPrompt ?? "",
		layers.role,
		...Option.toArray(Option.map(layers.brief, briefBlocks)),
		...Option.toArray(layers.principles),
		...Option.toArray(Option.map(layers.playbooks, (index) => `${playbooksWorkflow}\n\n${index}`)),
	];

	options.customPrompt = Arr.join(Arr.filter(Arr.map(parts, Str.trim), Str.isNonEmpty), "\n\n");
	options.sections["rules"] = rulesSection(options);

	options.skills = [...layers.skills];

	const skills = skillsSection(layers.skills);

	if (Option.isSome(skills)) {
		options.sections["skills"] = skills.value;
	}
};
