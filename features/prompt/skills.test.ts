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

const every: ReadonlyArray<Role> = ["root", "owner", "leaf"];

const rows: ReadonlyArray<{ name: string; text: string; fits: ReadonlyArray<Role>; problems: number }> = [
	{
		name: "a skill with no `for` fits every role",
		text: "---\nname: a\ndescription: A.\n---\nBody.",
		fits: every,
		problems: 0,
	},
	{
		name: "`for: [root]` hides a skill from owners and leaves",
		text: "---\nname: a\ndescription: A.\nfor: [root]\n---\nBody.",
		fits: ["root"],
		problems: 0,
	},
	{
		name: "`for: [owner, leaf]` hides a skill from the root",
		text: "---\nname: a\ndescription: A.\nfor: [owner, leaf]\n---\nBody.",
		fits: ["owner", "leaf"],
		problems: 0,
	},
	{
		name: "an unknown role leaves the skill out for every role and reports it",
		text: "---\nname: a\ndescription: A.\nfor: [delegate]\n---\nBody.",
		fits: [],
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

				const seen = yield* Effect.forEach(every, (role) =>
					Effect.map(skillsFor({ role, skills: [{ filePath }] }), ({ skills, problems }) => ({
						role,
						fits: Arr.isReadonlyArrayNonEmpty(skills),
						problems: problems.length,
					})),
				);

				expect(seen).toEqual(
					Arr.map(every, (role) => ({ role, fits: row.fits.includes(role), problems: row.problems })),
				);
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

const dirOf = (filePath: string) => Str.replace(/\/SKILL\.md$/u, "")(filePath);

const nameOf = (filePath: string) => Str.replace(/^.*\//u, "")(dirOf(filePath));

const hiddenFromModel = /^disable-model-invocation: true$/mu;

/** Every `.md` in a skill's folder, `SKILL.md` and the files it points at, keyed `<skill>/<path>`. */
const docsOf = (filePath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = dirOf(filePath);
		const entries = yield* fs.readDirectory(dir, { recursive: true });

		return yield* Effect.forEach(Arr.filter(entries, Str.endsWith(".md")), (doc) =>
			Effect.map(fs.readFileString(`${dir}/${doc}`), (text) => ({ doc: `${nameOf(filePath)}/${doc}`, text })),
		);
	});

/** The skills `text` points the agent at, written as `name` or **name**, out of `names`. */
const pointsAt = (text: string, names: ReadonlyArray<string>) =>
	Arr.filter(names, (name) => Str.includes(`\`${name}\``)(text) || Str.includes(`**${name}**`)(text));

const childRoles: ReadonlyArray<Role> = ["owner", "leaf"];

test("no skill an owner or a leaf loads points it at a skill hidden from its role", () =>
	run(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const skills = yield* shippedSkills;
			const forRoot = yield* skillsFor({ role: "root", skills });

			const pointers = yield* Effect.forEach(childRoles, (role) =>
				Effect.gen(function* () {
					const forRole = yield* skillsFor({ role, skills });

					const hidden = Arr.difference(
						Arr.map(forRoot.skills, ({ filePath }) => nameOf(filePath)),
						Arr.map(forRole.skills, ({ filePath }) => nameOf(filePath)),
					);

					return yield* Effect.forEach(forRole.skills, ({ filePath }) =>
						Effect.gen(function* () {
							const skillText = yield* fs.readFileString(filePath);

							if (hiddenFromModel.test(skillText)) {
								return [];
							}

							const docs = yield* docsOf(filePath);
							const texts = Arr.map(docs, ({ text }) => text);

							return Arr.map(
								pointsAt(Arr.join(texts, "\n"), hidden),
								(name) => `${role}: ${nameOf(filePath)} → ${name}`,
							);
						}),
					);
				}),
			);

			expect(Arr.flatten(Arr.flatten(pointers))).toEqual([]);
		}),
	));

/** Skill text that contradicts a rule the always-on prompt owns. `delegates` limits a phrase to the skills a delegate loads. */
const contradictions = [
	{ phrase: /reset --hard/u, rule: "<git> preserves unrelated changes", delegates: false },
	{ phrase: /ask before delet/iu, rule: "Subtract first deletes once it knows why the code exists", delegates: false },
	{
		phrase: /when you run as a delegate/iu,
		rule: "the owner and leaf role files own what a delegate does",
		delegates: false,
	},
	{
		phrase: /multiple agents or sessions/iu,
		rule: "the delegate rules say when parts run in parallel",
		delegates: false,
	},
	{
		phrase: /tasks one at a time/iu,
		rule: "the agent leading a build hands each slice to an owner",
		delegates: false,
	},
	{
		phrase: /STOP YOUR TURN/u,
		rule: "a delegate has no later turn, and the roles decide when to stop",
		delegates: true,
	},
];

test("no skill contradicts a rule the always-on prompt owns", () =>
	run(
		Effect.gen(function* () {
			const skills = yield* shippedSkills;
			const forDelegates = yield* Effect.forEach(childRoles, (role) => skillsFor({ role, skills }));

			const delegateSees = new Set(
				Arr.flatMap(forDelegates, (each) => Arr.map(each.skills, ({ filePath }) => filePath)),
			);

			const found = yield* Effect.forEach(skills, ({ filePath }) =>
				Effect.map(docsOf(filePath), (docs) =>
					Arr.flatMap(docs, ({ doc, text }) =>
						Arr.flatMap(contradictions, ({ phrase, rule, delegates }) =>
							phrase.test(text) && (!delegates || delegateSees.has(filePath)) ? [`${doc}: ${rule}`] : [],
						),
					),
				),
			);

			expect(Arr.flatten(found)).toEqual([]);
		}),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`.quiet())));
