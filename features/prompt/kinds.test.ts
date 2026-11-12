import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { Role } from "../owned-work/index.ts";
import { type Entry, entryIndex, type Kind, loadEntries } from "./kinds.ts";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/kinds-test-${String(process.pid)}`;

const agentDir = `${import.meta.dirname}/../../agent`;

const every: ReadonlyArray<Role> = ["root", "owner", "leaf"];

const kinds: ReadonlyArray<Kind> = ["principles", "playbooks"];

/** A leaf does one bounded task, so a playbook without `for` skips it, and a principle fits every role. */
const withoutFor: Record<Kind, ReadonlyArray<Role>> = { principles: every, playbooks: ["root", "owner"] };

const rows: ReadonlyArray<{ name: string; file: string; text: string; roles?: ReadonlyArray<Role> | "default" }> = [
	{
		name: "a file with no `for` fits its kind's roles",
		file: "fix-root-causes.md",
		text: "---\nwhen: Debugging.\n---\n# Fix\n\nBody.",
		roles: "default",
	},
	{
		name: "`for` narrows the roles",
		file: "ask-less.md",
		text: "---\nwhen: Asking.\nfor: [root]\n---\nBody.",
		roles: ["root"],
	},
	{
		name: "`for` can name a leaf",
		file: "read-cold.md",
		text: "---\nwhen: Reviewing.\nfor: [leaf]\n---\nBody.",
		roles: ["leaf"],
	},
	{ name: "an unknown key is refused", file: "a.md", text: "---\nwhen: x\ndescription: y\n---\nBody." },
	{ name: "a missing `when` is refused", file: "a.md", text: "---\nfor: [root]\n---\nBody." },
	{ name: "a multi-line `when` is refused", file: "a.md", text: "---\nwhen: |\n  one\n  two\n---\nBody." },
	{ name: "a `when` with angle brackets is refused", file: "a.md", text: "---\nwhen: use <tag>\n---\nBody." },
	{ name: "an unknown role is refused", file: "a.md", text: "---\nwhen: x\nfor: [human]\n---\nBody." },
	{ name: "an empty body is refused", file: "a.md", text: "---\nwhen: x\n---\n\n" },
	{ name: "a file with no frontmatter is refused", file: "a.md", text: "# Just a body" },
	{ name: "a file name that is not kebab case is refused", file: "Fix_Root.md", text: "---\nwhen: x\n---\nBody." },
];

const write = Effect.fn("write")(function* (dir: string, file: string, text: string) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.makeDirectory(Str.replace(/\/[^/]*$/u, "")(`${dir}/${file}`), { recursive: true });
	yield* fs.writeFileString(`${dir}/${file}`, text);
});

const run = <Success, Failure>(effect: Effect.Effect<Success, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

for (const kind of kinds) {
	for (const [index, row] of rows.entries()) {
		test(`${kind}: ${row.name}`, () =>
			run(
				Effect.gen(function* () {
					const dir = `${scratch}/${String(index)}/${kind}`;

					yield* write(dir, row.file, row.text);

					const { entries, problems } = yield* loadEntries(kind, dir);
					const loaded = Arr.map(entries, ({ name, roles }) => ({ name, roles }));
					const name = Str.replace(/\.md$/u, "")(row.file);

					expect({ loaded, problems: problems.length }).toEqual(
						row.roles === undefined
							? { loaded: [], problems: 1 }
							: {
									loaded: [{ name, roles: row.roles === "default" ? withoutFor[kind] : row.roles }],
									problems: 0,
								},
					);
				}),
			));
	}
}

test("a file in a playbook's subfolder is a reference file: neither listed nor refused", () =>
	run(
		Effect.gen(function* () {
			const dir = `${scratch}/subfolder/playbooks`;

			yield* write(dir, "bug-fix.md", "---\nwhen: Fixing a bug.\n---\nBody.");
			yield* write(dir, "bug-fix/notes.md", "No frontmatter at all.");

			const { entries, problems } = yield* loadEntries("playbooks", dir);

			expect({ names: Arr.map(entries, ({ name }) => name), problems }).toEqual({
				names: ["bug-fix"],
				problems: [],
			});
		}),
	));

test("a missing folder holds no entries and no problems", () =>
	run(
		Effect.gen(function* () {
			const { entries, problems } = yield* loadEntries("playbooks", `${scratch}/missing/playbooks`);

			expect({ entries, problems }).toEqual({ entries: [], problems: [] });
		}),
	));

for (const kind of kinds) {
	test(`the ${kind} index names the folder once, then each entry's name and trigger, only for the roles it fits`, () => {
		const everywhere: Entry = { name: "bug-fix", when: "Debugging.", roles: every };
		const rootOnly: Entry = { name: "ask-less", when: "Asking.", roles: ["root"] };

		expect(entryIndex({ kind, role: "leaf", dir: "/p", entries: [everywhere, rootOnly] })).toEqual(
			Option.some(`<${kind} dir="/p">\n- bug-fix: Debugging.\n</${kind}>`),
		);

		expect(entryIndex({ kind, role: "root", dir: "/p", entries: [everywhere, rootOnly] })).toEqual(
			Option.some(`<${kind} dir="/p">\n- bug-fix: Debugging.\n- ask-less: Asking.\n</${kind}>`),
		);

		expect(entryIndex({ kind, role: "leaf", dir: "/p", entries: [rootOnly] })).toEqual(Option.none());
		expect(entryIndex({ kind, role: "root", dir: "/p", entries: [] })).toEqual(Option.none());
	});
}

/** The names `text` points at as `principle-<name>`, the one spelling prompts and answers use. */
const principleReferences = (text: string) => {
	const found = [...Str.matchAll(/\bprinciple-(?<name>[a-z][a-z0-9-]*[a-z0-9])/gu)(text)];

	return Arr.dedupe(Arr.map(found, (match) => match.groups?.["name"] ?? ""));
};

/** The names `text` points at as `playbooks/<name>.md`. A file in a playbook's subfolder names no playbook. */
const playbookReferences = (text: string) => {
	const found = [...Str.matchAll(/\bplaybooks\/(?<name>[a-z][a-z0-9-]*)\.md\b/gu)(text)];

	return Arr.dedupe(Arr.map(found, (match) => match.groups?.["name"] ?? ""));
};

test("playbooks/<name>.md names a playbook, and a file in a playbook's subfolder does not", () => {
	const text = "Run `playbooks/bug-fix.md`, then read playbooks/bug-fix/notes.md and agent/playbooks/<name>.md.";

	expect(playbookReferences(text)).toEqual(["bug-fix"]);
});

/** The text of `SYSTEM.md` and of every `.md` file under each folder of the agent dir. A missing folder has none. */
const promptTexts = (folders: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const listed = yield* Effect.forEach(folders, (folder) =>
			Effect.gen(function* () {
				const files = (yield* fs.exists(`${agentDir}/${folder}`))
					? yield* fs.readDirectory(`${agentDir}/${folder}`, { recursive: true })
					: [];

				return Arr.map(Arr.filter(files, Str.endsWith(".md")), (file) => `${folder}/${file}`);
			}),
		);

		return yield* Effect.forEach(["SYSTEM.md", ...Arr.flatten(listed)], (file) =>
			fs.readFileString(`${agentDir}/${file}`),
		);
	});

const namesIn = (kind: Kind) =>
	Effect.gen(function* () {
		const { entries, problems } = yield* loadEntries(kind, `${agentDir}/${kind}`);

		expect(problems).toEqual([]);

		return Arr.map(entries, ({ name }) => name);
	});

test("every shipped principle loads, and every principle-<name> in the prompt files and playbooks names one", () =>
	run(
		Effect.gen(function* () {
			const texts = yield* promptTexts(["roles", "instructions", "playbooks"]);
			const names = yield* namesIn("principles");
			const named = Arr.dedupe(Arr.flatMap(texts, principleReferences));

			expect(Arr.difference(named, names)).toEqual([]);
		}),
	));

test("every shipped playbook loads, and every playbooks/<name>.md in a skill, playbook, role, instructions file or reference names one", () =>
	run(
		Effect.gen(function* () {
			const texts = yield* promptTexts(["roles", "instructions", "references", "skills", "playbooks"]);
			const names = yield* namesIn("playbooks");
			const named = Arr.dedupe(Arr.flatMap(texts, playbookReferences));

			expect(Arr.difference(named, names)).toEqual([]);
		}),
	));

test("a principle stands alone: none names a principle as principle-<name>", () =>
	run(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = `${agentDir}/principles`;
			const files = yield* fs.readDirectory(dir);

			const named = yield* Effect.forEach(files, (file) =>
				Effect.map(fs.readFileString(`${dir}/${file}`), (text) => ({ file, names: principleReferences(text) })),
			);

			expect(Arr.filter(named, ({ names }) => Arr.isReadonlyArrayNonEmpty(names))).toEqual([]);
		}),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`.quiet())));
