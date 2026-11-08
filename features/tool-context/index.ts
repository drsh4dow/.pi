import type { BeforeAgentStartEvent, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

const bullets = (lines: ReadonlyArray<string>) =>
	Arr.join(
		Arr.map(lines, (line) => `- ${line}`),
		"\n",
	);

/** The `<tools>` and `<rules>` sections pi builds for its default prompt, minus its generic style rules. */
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

/** A custom SYSTEM.md replaces pi's default prompt, tool list and rules included, so this puts those two back. */
export const restoreToolContext = (event: BeforeAgentStartEvent) => {
	const options = event.systemPromptOptions;

	if (Str.isNonEmpty(options.customPrompt ?? "")) {
		Object.assign(options.sections, toolSections(options));
	}
};
