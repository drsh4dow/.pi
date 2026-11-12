import {
	type BeforeAgentStartEvent,
	type NormalizedBuildSystemPromptOptions,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { skillsSection } from "./skills.ts";

/** What the harness adds after `SYSTEM.md`. The role, principles and playbooks arrive rendered. The instructions arrive raw, and `compose` wraps them. */
export interface Layers {
	/** The role file: its `<role>` and `<collaboration>` blocks. */
	readonly role: string;
	/** A delegate's own instructions, from the instructions file its parent named. */
	readonly instructions: Option.Option<string>;
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

const instructionsBlock = (text: string) => `<instructions>\n${Str.trim(text)}\n</instructions>`;

/**
 * Writes `SYSTEM.md`, the role file, the delegate's instructions and the principles and playbooks indexes into pi's
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
		...Option.toArray(Option.map(layers.instructions, instructionsBlock)),
		...Option.toArray(layers.principles),
		...Option.toArray(layers.playbooks),
	];

	options.customPrompt = Arr.join(Arr.filter(Arr.map(parts, Str.trim), Str.isNonEmpty), "\n\n");
	options.sections["rules"] = rulesSection(options);

	options.skills = [...layers.skills];

	const skills = skillsSection(layers.skills);

	if (Option.isSome(skills)) {
		options.sections["skills"] = skills.value;
	}
};
