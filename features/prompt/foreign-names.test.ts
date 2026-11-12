import { afterAll, expect, test } from "bun:test";

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
		"Start one delegate per angle and group them.",
		"Write `.cursor/skills/verify-app/SKILL.md`.",
		"Per the **prove-it-works** principle skill.",
	];

	const text = Arr.join(lines, "\n");

	expect(Arr.map(hitsIn("f.md", text), Str.slice(0, 7))).toEqual(["f.md:1:", "f.md:3:", "f.md:4:"]);
});

const promptFolders = [
	"agent/skills",
	"agent/instructions",
	"agent/roles",
	"agent/references",
	"agent/playbooks",
	"features",
];

const isPromptFile = (file: string) => Str.endsWith(".md")(file) && !Str.includes("node_modules")(file);

/** Every hit in the prompt files under `root`. A missing folder has no files. */
const hitsUnder = Effect.fn("hitsUnder")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;

	const listed = yield* Effect.forEach(promptFolders, (folder) =>
		Effect.gen(function* () {
			const files = (yield* fs.exists(`${root}${folder}`))
				? yield* fs.readDirectory(`${root}${folder}`, { recursive: true })
				: [];

			return Arr.map(Arr.filter(files, isPromptFile), (file) => `${folder}/${file}`);
		}),
	);

	const hits = yield* Effect.forEach(Arr.flatten(listed), (file) =>
		Effect.map(fs.readFileString(`${root}${file}`), (text) => hitsIn(file, text)),
	);

	return Arr.flatten(hits);
});

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/foreign-names-test-${String(process.pid)}/`;

test("a playbook and a reference file in its subfolder are scanned", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* fs.makeDirectory(`${scratch}agent/playbooks/bug-fix`, { recursive: true });
			yield* fs.writeFileString(`${scratch}agent/playbooks/bug-fix.md`, "Spawn a `Task` per angle.");
			yield* fs.writeFileString(`${scratch}agent/playbooks/bug-fix/notes.md`, "Ask with AskQuestion.");

			const hits = yield* hitsUnder(scratch);

			expect(Arr.map(hits, Str.replace(/: .*$/u, ""))).toEqual([
				"agent/playbooks/bug-fix.md:1",
				"agent/playbooks/bug-fix/notes.md:1",
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	));

test("no skill, instructions file, role file, reference or playbook names a tool, path or skill of another harness", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const hits = yield* hitsUnder(harness);

			expect(hits).toEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`.quiet())));
