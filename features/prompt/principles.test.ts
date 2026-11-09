import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { Role } from "../owned-work/index.ts";
import { loadPrinciples, type Principle, principleIndex } from "./principles.ts";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/principles-test-${String(process.pid)}`;

const agentDir = `${import.meta.dirname}/../../agent`;

const every: ReadonlyArray<Role> = ["root", "delegate"];

const rows: ReadonlyArray<{ name: string; file: string; text: string; roles?: ReadonlyArray<Role> }> = [
	{
		name: "a principle fits every role",
		file: "fix-root-causes.md",
		text: "---\nwhen: Debugging.\n---\n# Fix\n\nBody.",
		roles: every,
	},
	{
		name: "`for` narrows the roles",
		file: "ask-less.md",
		text: "---\nwhen: Asking.\nfor: [root]\n---\nBody.",
		roles: ["root"],
	},
	{ name: "an unknown key is refused", file: "a.md", text: "---\nwhen: x\ndescription: y\n---\nBody." },
	{ name: "a missing `when` is refused", file: "a.md", text: "---\nfor: [root]\n---\nBody." },
	{ name: "a `when` with angle brackets is refused", file: "a.md", text: "---\nwhen: use <tag>\n---\nBody." },
	{ name: "an unknown role is refused", file: "a.md", text: "---\nwhen: x\nfor: [human]\n---\nBody." },
	{ name: "an empty body is refused", file: "a.md", text: "---\nwhen: x\n---\n\n" },
	{ name: "a file with no frontmatter is refused", file: "a.md", text: "# Just a body" },
	{ name: "a file name that is not kebab case is refused", file: "Fix_Root.md", text: "---\nwhen: x\n---\nBody." },
];

for (const [index, row] of rows.entries()) {
	test(row.name, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const dir = `${scratch}/${String(index)}`;

				yield* fs.makeDirectory(dir, { recursive: true });
				yield* fs.writeFileString(`${dir}/${row.file}`, row.text);

				const { principles, problems } = yield* loadPrinciples(dir);
				const loaded = Arr.map(principles, ({ name, roles }) => ({ name, roles }));
				const name = Str.replace(/\.md$/u, "")(row.file);

				expect({ loaded, problems: problems.length }).toEqual(
					row.roles === undefined
						? { loaded: [], problems: 1 }
						: { loaded: [{ name, roles: row.roles }], problems: 0 },
				);
			}).pipe(Effect.provide(NodeServices.layer)),
		),
	);
}

test("the index names the folder once, then each principle's name and trigger, only for the roles it fits", () => {
	const everywhere: Principle = { name: "fix-root-causes", when: "Debugging.", roles: every };
	const rootOnly: Principle = { name: "ask-less", when: "Asking.", roles: ["root"] };

	expect(principleIndex({ role: "delegate", dir: "/p", principles: [everywhere, rootOnly] })).toEqual(
		Option.some('<principles dir="/p">\n- fix-root-causes: Debugging.\n</principles>'),
	);

	expect(principleIndex({ role: "delegate", dir: "/p", principles: [rootOnly] })).toEqual(Option.none());
});

/** The names `text` points at as `principle-<name>`, the one spelling prompts and answers use. */
const references = (text: string) => {
	const found = [...Str.matchAll(/\bprinciple-(?<name>[a-z][a-z0-9-]*[a-z0-9])/gu)(text)];

	return Arr.dedupe(Arr.map(found, (match) => match.groups?.["name"] ?? ""));
};

/** The agent files whose text reaches a prompt: the shared layer, the role files, the principles and the instructions files. */
const promptFiles = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	const listed = yield* Effect.forEach(["roles", "principles", "instructions"], (folder) =>
		Effect.map(
			fs.readDirectory(`${agentDir}/${folder}`),
			Arr.map((name) => `${folder}/${name}`),
		),
	);

	return ["SYSTEM.md", ...Arr.flatten(listed)];
});

test("every shipped principle loads, and every principle-<name> in the prompt files names one", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const files = yield* promptFiles;
			const texts = yield* Effect.forEach(files, (file) => fs.readFileString(`${agentDir}/${file}`));
			const { principles, problems } = yield* loadPrinciples(`${agentDir}/principles`);
			const named = Arr.dedupe(Arr.flatMap(texts, references));
			const names = Arr.map(principles, ({ name }) => name);

			expect(problems).toEqual([]);
			expect(Arr.difference(named, names)).toEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`.quiet())));
