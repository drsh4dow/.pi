import { expect, test } from "bun:test";

import {
	createSyntheticSourceInfo,
	type NormalizedBuildSystemPromptOptions,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { compose, type Layers } from "./compose.ts";

const options = (overrides: Partial<NormalizedBuildSystemPromptOptions>): NormalizedBuildSystemPromptOptions => ({
	customPrompt: "you are a coding agent.\n",
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
	...overrides,
});

const root: Layers = {
	role: "<role>\nroot\n</role>",
	instructions: Option.none(),
	principles: Option.none(),
	skills: [],
};

const composed = (given: NormalizedBuildSystemPromptOptions, layers: Layers) => {
	compose(layers)({
		type: "before_agent_start",
		messageType: "user",
		prompt: "hi",
		systemPrompt: "",
		systemPromptOptions: given,
	});

	return given;
};

const readAndBash = "- read: Read file contents\n- bash: Run a command";

const preambleRows = [
	{
		name: "the root reads SYSTEM.md, then its role file",
		shared: "you are a coding agent.\n",
		layers: root,
		expect: "you are a coding agent.\n\n<role>\nroot\n</role>",
	},
	{
		name: "a delegate reads SYSTEM.md, its role file, its instructions, then the principles index",
		shared: "you are a coding agent.",
		layers: {
			role: "<role>\ndelegate\n</role>\n",
			instructions: Option.some("Review one diff.\n"),
			principles: Option.some("<principles>\n…\n</principles>"),
			skills: [],
		},
		expect:
			"you are a coding agent.\n\n<role>\ndelegate\n</role>\n\n<instructions>\nReview one diff.\n</instructions>\n\n<principles>\n…\n</principles>",
	},
	{
		name: "with no SYSTEM.md the role layer still comes first",
		shared: "",
		layers: root,
		expect: "<role>\nroot\n</role>",
	},
];

for (const row of preambleRows) {
	test(row.name, () => {
		expect(composed(options({ customPrompt: row.shared }), row.layers).customPrompt).toBe(row.expect);
	});
}

const sectionRows = [
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

for (const { name, given, tools, rules } of sectionRows) {
	test(`the tool context ${name}`, () => {
		const { sections } = composed(options(given), root);

		expect({ tools: sections["tools"], rules: sections["rules"] }).toEqual({ tools, rules });
	});
}

test("every prompt gets pi's docs paths back", () => {
	expect(composed(options({}), root).sections["docs"]).toContain("- Docs: ");
});

const skill = (
	name: string,
	description: string,
	{ disableModelInvocation = false, filePath = `/skills/${name}/SKILL.md` } = {},
): Skill => ({
	name,
	description,
	filePath,
	baseDir: Str.replace(/\/[^/]+$/u, "")(filePath),
	sourceInfo: createSyntheticSourceInfo(filePath, { source: "local" }),
	disableModelInvocation,
});

test("the skills section lists each skill the model may invoke as one line under its folder, after the rule", () => {
	const skills = [
		skill("grilling", "Grill the user's plan."),
		skill("agent-browser", "Drive a\n  real browser.\n", { filePath: "/web/agent-browser/SKILL.md" }),
		skill("handoff", "Hand off.", { disableModelInvocation: true }),
		skill("tdd", "Red, then green."),
	];

	const section = composed(options({}), { ...root, skills }).sections["skills"] ?? "";

	expect(section).toStartWith("Skills are workflows, not suggestions.");

	expect(section).toEndWith(
		'\n\n<available_skills dir="/skills">\n- grilling: Grill the user\'s plan.\n- tdd: Red, then green.\n</available_skills>\n<available_skills dir="/web">\n- agent-browser: Drive a real browser.\n</available_skills>',
	);
});

test("a skill whose file is not <dir>/<name>/SKILL.md is listed with its path", () => {
	const skills = [
		skill("notes", "Take notes.", { filePath: "/skills/notes.md" }),
		skill("renamed", "Renamed.", { filePath: "/skills/old-name/SKILL.md" }),
	];

	expect(composed(options({}), { ...root, skills }).sections["skills"]).toEndWith(
		"\n\n<available_skills>\n- notes (/skills/notes.md): Take notes.\n- renamed (/skills/old-name/SKILL.md): Renamed.\n</available_skills>",
	);
});

test("with no skill the model may invoke, the prompt gets no skills section", () => {
	const skills = [skill("handoff", "Hand off.", { disableModelInvocation: true })];

	expect(composed(options({}), { ...root, skills }).sections).not.toHaveProperty("skills");
});

test("pi keeps only the skills the role may load, so its own list never brings back a hidden one", () => {
	const loaded = [skill("grilling", "Grill the user's plan."), skill("handoff", "Hand off.")];
	const fitting = [skill("handoff", "Hand off.")];

	expect(composed(options({ skills: loaded }), { ...root, skills: fitting }).skills).toEqual(fitting);
});
