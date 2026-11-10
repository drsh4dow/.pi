import { afterAll, expect, test } from "bun:test";

import type { AutocompleteProviderFactory, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { hidesFromMenu, withoutHiddenSkills } from "./index.ts";

type AutocompleteProvider = Parameters<AutocompleteProviderFactory>[0];

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/skill-menu-test-${String(process.pid)}`;

const skillFile = (frontmatter: string) => `---\nname: x\ndescription: Does x.\n${frontmatter}---\n\nBody.\n`;

const rows: ReadonlyArray<{ name: string; text: string; hides: boolean }> = [
	{ name: "`user-invocable: false` hides the skill", text: skillFile("user-invocable: false\n"), hides: true },
	{ name: "`user-invocable: true` shows the skill", text: skillFile("user-invocable: true\n"), hides: false },
	{ name: "a skill without the key shows", text: skillFile(""), hides: false },
	{ name: 'the string "false" is not the boolean', text: skillFile('user-invocable: "false"\n'), hides: false },
	{ name: "unparseable frontmatter shows the skill", text: "---\nname: [x\n---\nBody.\n", hides: false },
];

for (const row of rows) {
	test(row.name, () => {
		expect(hidesFromMenu(row.text)).toBe(row.hides);
	});
}

const command = (name: string, path: string): SlashCommandInfo => ({
	name: `skill:${name}`,
	source: "skill",
	sourceInfo: { path, source: "local", scope: "user", origin: "top-level" },
});

/** A stand-in for pi's own provider: it suggests the given values for any input. */
const fixedProvider = (values: ReadonlyArray<string>): AutocompleteProvider => ({
	getSuggestions: () => Promise.resolve({ prefix: "/", items: Arr.map(values, (value) => ({ value, label: value })) }),
	applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
});

const suggest = (provider: AutocompleteProvider) =>
	Effect.promise(() => provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal })).pipe(
		Effect.map((suggestions) => Arr.map(suggestions?.items ?? [], (item) => item.value)),
	);

test("the menu leaves out hidden skills and keeps every other command", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* fs.makeDirectory(scratch, { recursive: true });
			yield* fs.writeFileString(`${scratch}/hidden.md`, skillFile("user-invocable: false\n"));
			yield* fs.writeFileString(`${scratch}/shown.md`, skillFile(""));

			const commands = [
				command("hidden", `${scratch}/hidden.md`),
				command("shown", `${scratch}/shown.md`),
				command("unreadable", `${scratch}/missing.md`),
			];

			const provider = withoutHiddenSkills(() => commands)(
				fixedProvider(["model", "skill:hidden", "skill:shown", "skill:unreadable"]),
			);

			const shown = yield* suggest(provider);

			expect(shown).toEqual(["model", "skill:shown", "skill:unreadable"]);
		}).pipe(Effect.provide(NodeServices.layer)),
	));

test("the menu shows a hidden skill again once its file drops the key", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = `${scratch}/edited.md`;

			yield* fs.makeDirectory(scratch, { recursive: true });
			yield* fs.writeFileString(path, skillFile("user-invocable: false\n"));

			const provider = withoutHiddenSkills(() => [command("edited", path)])(fixedProvider(["skill:edited"]));
			const before = yield* suggest(provider);

			yield* fs.writeFileString(path, skillFile(""));

			const after = yield* suggest(provider);

			expect({ before, after }).toEqual({
				before: [],
				after: ["skill:edited"],
			});
		}).pipe(Effect.provide(NodeServices.layer)),
	));

afterAll(() =>
	Effect.runPromise(
		Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(scratch, { recursive: true, force: true })).pipe(
			Effect.provide(NodeServices.layer),
		),
	),
);
