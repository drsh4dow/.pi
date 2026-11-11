import {
	type BeforeAgentStartEvent,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { skillsSection } from "./skills.ts";

/** What the harness adds after `SYSTEM.md`. The role and principles arrive rendered. The instructions arrive raw, and `compose` wraps them. */
export interface Layers {
	/** The role file: its `<role>` and `<collaboration>` blocks. */
	readonly role: string;
	/** A delegate's own instructions, from the instructions file its parent named. */
	readonly instructions: Option.Option<string>;
	/** The `<principles>` index. */
	readonly principles: Option.Option<string>;
}

const bullets = (lines: ReadonlyArray<string>) =>
	Arr.join(
		Arr.map(lines, (line) => `- ${line}`),
		"\n",
	);

/** The `<tools>` and `<rules>` sections pi builds for its default prompt, without the rules and footer pi hardcodes. */
const toolSections = (options: NormalizedBuildSystemPromptOptions) => {
	const declared = Arr.difference(options.selectedTools, options.hiddenTools);

	const described = Arr.filter(declared, (name) => Str.isNonEmpty(options.toolSnippets[name] ?? ""));
	const tools = Arr.map(described, (name) => `${name}: ${options.toolSnippets[name] ?? ""}`);

	const guidelines = [
		...Arr.flatMap(declared, (name) => options.toolGuidelines[name] ?? []),
		...options.promptGuidelines,
	];

	const trimmed = Arr.map(guidelines, Str.trim);
	const rules = Arr.dedupe(Arr.filter(trimmed, Str.isNonEmpty));

	return { tools: bullets(tools), rules: bullets(rules) };
};

const docs = () =>
	Arr.join(
		[
			"Pi is the host this harness runs in. Read its docs before you change the harness itself: an extension, SYSTEM.md, a role file, or a principle.",
			`- README: ${getReadmePath()}`,
			`- Docs: ${getDocsPath()}`,
			`- Examples: ${getExamplesPath()}`,
		],
		"\n",
	);

const instructionsBlock = (text: string) => `<instructions>\n${Str.trim(text)}\n</instructions>`;

/**
 * Writes `SYSTEM.md`, the role file, the delegate's instructions and the principles index into pi's preamble, so they
 * render before `<project_context>`. A custom preamble makes pi drop its `<tools>`, `<rules>` and `<docs>`, so this adds
 * them back as custom sections, which pi renders last. The `<skills>` section replaces pi's own in place. pi builds fresh
 * options for each run, so running this again never stacks.
 */
export const compose = (layers: Layers) => (event: BeforeAgentStartEvent) => {
	const options = event.systemPromptOptions;

	const parts = [
		options.customPrompt ?? "",
		layers.role,
		...Option.toArray(Option.map(layers.instructions, instructionsBlock)),
		...Option.toArray(layers.principles),
	];

	options.customPrompt = Arr.join(Arr.filter(Arr.map(parts, Str.trim), Str.isNonEmpty), "\n\n");
	Object.assign(options.sections, toolSections(options), { docs: docs() });

	const skills = skillsSection(options.skills);

	if (Option.isSome(skills)) {
		options.sections["skills"] = skills.value;
	}
};
