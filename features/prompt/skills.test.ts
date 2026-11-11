import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Str from "effect/String";

import type { Role } from "../owned-work/index.ts";
import { skillsFor } from "./skills.ts";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/skills-test-${String(process.pid)}`;

const harness = `${import.meta.dirname}/../..`;

const run = <Out, Err>(effect: Effect.Effect<Out, Err, FileSystem.FileSystem>) =>
	Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const rows: ReadonlyArray<{ name: string; text: string; root: boolean; delegate: boolean; problems: number }> = [
	{
		name: "a skill with no `for` fits every role",
		text: "---\nname: a\ndescription: A.\n---\nBody.",
		root: true,
		delegate: true,
		problems: 0,
	},
	{
		name: "`for: [root]` hides a skill from a delegate",
		text: "---\nname: a\ndescription: A.\nfor: [root]\n---\nBody.",
		root: true,
		delegate: false,
		problems: 0,
	},
	{
		name: "`for: [delegate]` hides a skill from the root",
		text: "---\nname: a\ndescription: A.\nfor: [delegate]\n---\nBody.",
		root: false,
		delegate: true,
		problems: 0,
	},
	{
		name: "an unknown role leaves the skill out for every role and reports it",
		text: "---\nname: a\ndescription: A.\nfor: [human]\n---\nBody.",
		root: false,
		delegate: false,
		problems: 1,
	},
];

for (const [index, row] of rows.entries()) {
	test(row.name, () =>
		run(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const filePath = `${scratch}/${String(index)}/SKILL.md`;

				yield* fs.makeDirectory(`${scratch}/${String(index)}`, { recursive: true });
				yield* fs.writeFileString(filePath, row.text);

				const seen = (role: Role) =>
					Effect.map(skillsFor({ role, skills: [{ filePath }] }), ({ skills, problems }) => ({
						fits: Arr.isReadonlyArrayNonEmpty(skills),
						problems: problems.length,
					}));

				const root = yield* seen("root");
				const delegate = yield* seen("delegate");

				expect({ root, delegate }).toEqual({
					root: { fits: row.root, problems: row.problems },
					delegate: { fits: row.delegate, problems: row.problems },
				});
			}),
		),
	);
}

test("a skill file that cannot be read is left out and reported", () =>
	run(
		Effect.gen(function* () {
			const { skills, problems } = yield* skillsFor({
				role: "root",
				skills: [{ filePath: `${scratch}/missing/SKILL.md` }],
			});

			expect({ skills, problems: problems.length }).toEqual({ skills: [], problems: 1 });
		}),
	));

const isSkillFile = (entry: string) => /^[^/]+\/SKILL\.md$/u.test(entry);

/** Every `SKILL.md` pi loads from this harness: `agent/skills/*` and the web feature's skills. */
const shippedSkills = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	const found = yield* Effect.forEach(["agent/skills", "features/web"], (folder) =>
		Effect.map(fs.readDirectory(`${harness}/${folder}`, { recursive: true }), (entries) =>
			Arr.map(Arr.filter(entries, isSkillFile), (entry) => ({ filePath: `${harness}/${folder}/${entry}` })),
		),
	);

	return Arr.flatten(found);
});

test("every shipped skill's `for` names known roles", () =>
	run(
		Effect.gen(function* () {
			const skills = yield* shippedSkills;
			const { problems } = yield* skillsFor({ role: "root", skills });

			expect(Arr.isReadonlyArrayNonEmpty(skills)).toBe(true);
			expect(Arr.map(problems, ({ file, why }) => `${Str.replace(harness, "")(file)}: ${why}`)).toEqual([]);
		}),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`.quiet())));
