import { expect, test } from "bun:test";

import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

import { restoreToolContext } from "./index.ts";

const defaultPrompt = (): NormalizedBuildSystemPromptOptions => ({
	selectedTools: ["read", "bash"],
	hiddenTools: [],
	toolSnippets: { read: "Read file contents", bash: "Run a command" },
	toolGuidelines: {},
	promptGuidelines: [],
	appendSystemPrompt: "",
	sections: {},
	cwd: "/project",
	contextFiles: [],
	skills: [],
});

const customPrompt = (overrides: Partial<NormalizedBuildSystemPromptOptions>): NormalizedBuildSystemPromptOptions => ({
	...defaultPrompt(),
	customPrompt: "You are a coding agent.",
	...overrides,
});

const sectionsAfterRestore = (options: NormalizedBuildSystemPromptOptions) => {
	restoreToolContext({
		type: "before_agent_start",
		messageType: "user",
		prompt: "hi",
		systemPrompt: "",
		systemPromptOptions: options,
	});

	return options.sections;
};

const readAndBash = "- read: Read file contents\n- bash: Run a command";

const rows = [
	{ name: "lists each selected tool with its snippet", given: {}, tools: readAndBash, rules: "" },
	{
		name: "leaves out a hidden tool",
		given: { hiddenTools: ["bash"] },
		tools: "- read: Read file contents",
		rules: "",
	},
	{
		name: "leaves out a tool with no snippet",
		given: { toolSnippets: { read: "Read file contents" } },
		tools: "- read: Read file contents",
		rules: "",
	},
	{
		name: "gathers tool and prompt guidelines, trimmed and once each",
		given: {
			toolGuidelines: { read: [" Use read, not cat. "], bash: ["Quote paths."] },
			promptGuidelines: ["Quote paths.", " "],
		},
		tools: readAndBash,
		rules: "- Use read, not cat.\n- Quote paths.",
	},
	{
		name: "drops the guidelines of a hidden tool",
		given: { hiddenTools: ["read"], toolGuidelines: { read: ["Use read."] } },
		tools: "- bash: Run a command",
		rules: "",
	},
] satisfies ReadonlyArray<{
	name: string;
	given: Partial<NormalizedBuildSystemPromptOptions>;
	tools: string;
	rules: string;
}>;

for (const { name, given, tools, rules } of rows) {
	test(`a custom prompt ${name}`, () => {
		expect(sectionsAfterRestore(customPrompt(given))).toEqual({ tools, rules });
	});
}

test("pi's default prompt, which already has both sections, is left alone", () => {
	expect(sectionsAfterRestore(defaultPrompt())).toEqual({});
});

test("an empty custom prompt, which makes pi use its default prompt, is left alone", () => {
	expect(sectionsAfterRestore(customPrompt({ customPrompt: "" }))).toEqual({});
});
