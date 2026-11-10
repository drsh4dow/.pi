import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Str from "effect/String";

const harness = Bun.fileURLToPath(new URL("../..", import.meta.url));

/**
 * Names from the harness a skill was ported from: Cursor's Task tool and its fields, its model rules, its paths, and
 * pstack's own skills. Each has a pi name, and an agent here can act only on that one.
 */
const foreign =
	/subagent_type|run_in_background|generalPurpose|cloud_base_branch|environment: "|\bTask (?:tool|subagent)|`Task`|AskQuestion|todolist|\b(?:Ask|agent) mode\b|pstack|poteto|\bCursor\b|\.cursor\b|\.mdc\b|principle skill/u;

const hitsIn = (file: string, text: string) =>
	Arr.flatMap(Str.split("\n")(text), (line, index) =>
		foreign.test(line) ? [`${file}:${String(index + 1)}: ${Str.slice(0, 80)(Str.trim(line))}`] : [],
	);

test("a line that names Cursor's Task tool, a pstack skill or a .cursor path is a hit, and a pi line is not", () => {
	const lines = [
		"Spawn a Task subagent with `subagent_type: generalPurpose`.",
		"Start one delegate per angle and group them with mode `all`.",
		"Write `.cursor/skills/verify-app/SKILL.md`.",
		"Per the **prove-it-works** principle skill.",
	];

	const text = Arr.join(lines, "\n");

	expect(Arr.map(hitsIn("f.md", text), Str.slice(0, 7))).toEqual(["f.md:1:", "f.md:3:", "f.md:4:"]);
});

const promptFolders = ["agent/skills", "agent/instructions", "agent/roles", "features"];

const isPromptFile = (file: string) => Str.endsWith(".md")(file) && !Str.includes("node_modules")(file);

test("no skill, instructions file or role file names a tool, path or skill of another harness", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			const listed = yield* Effect.forEach(promptFolders, (folder) =>
				Effect.map(fs.readDirectory(`${harness}${folder}`, { recursive: true }), (files) =>
					Arr.map(Arr.filter(files, isPromptFile), (file) => `${folder}/${file}`),
				),
			);

			const hits = yield* Effect.forEach(Arr.flatten(listed), (file) =>
				Effect.map(fs.readFileString(`${harness}${file}`), (text) => hitsIn(file, text)),
			);

			expect(Arr.flatten(hits)).toEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	));
