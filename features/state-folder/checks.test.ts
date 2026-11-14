import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Str from "effect/String";

import { checks } from "./checks.ts";

const home = `${Bun.env["TMPDIR"] ?? "/tmp"}/state-checks-test-${String(process.pid)}`;
const folder = `${home}/.local/state/pi-agent/pi/work`;

const runTest = <Value, Failure>(effect: Effect.Effect<Value, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

await runTest(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		yield* fs.makeDirectory(folder, { recursive: true });
		yield* fs.writeFileString(`${folder}/ruleset.log`, "403\n");
		yield* fs.writeFileString(`${home}/denied.log`, "403\n");
	}),
);

/** The problems a state file's check finds in these bytes: their lines, and their messages as one text. */
const problemsIn = Effect.fn("problemsIn")(function* (name: string, file: Uint8Array) {
	const check = yield* Effect.fromNullishOr(checks.get(name));
	const problems = yield* check.problems(file, { home, folder });

	return {
		lines: Arr.map(problems, ({ line }) => line),
		messages: Arr.join(
			Arr.map(problems, ({ message }) => message),
			"\n",
		),
	};
});

const problemsOf = (name: string, text: string) => problemsIn(name, new TextEncoder().encode(text));

const sixteenKib = Arr.join(Arr.replicate(Str.repeat(1023)("x"), 16), "\n");

test.each([
	["a dated level-2 heading", "# State\n\n## 2026-11-13 session\nDid things.\n", [3]],
	["a dated level-3 heading", "# State\n\n## Status\n### Done 2026-11-13\n", [4]],
	["a dated heading indented three spaces", "# State\n\n   ## Status 2026-11-14\n", [3]],
	["a dated line indented four spaces, which is code", "# State\n\n    ## Status 2026-11-14\n", []],
	["a dated heading after a fence indented into code", "# State\n\n    ```\n## 2026-11-13\n    ```\n", [4]],
	["a dated heading after a fence whose info holds a backtick", "# State\n\n```not`fence\n## 2026-11-13\n", [4]],
	["a dated title of level 1", "# Work started 2026-11-13\n\n## Status\n", []],
	["seven hashes, which is text", "# State\n\n####### 2026-11-13\n", []],
	["a dated heading in a quote", "# State\n\n> ## 2026-11-13\n", [3]],
	["a dated underlined heading", "# State\n\n2026-11-13\n---\n", [3]],
	["a dated heading in a list's second item", "# State\n\n- first\n- ## Status 2026-11-13\n", [4]],
	[
		"CRLF line ends and the heading's date in a fence above it",
		`${Str.repeat(100)("x\r\n")}\r\n\`\`\`\r\n2026-11-13\r\n\`\`\`\r\n## 2026-11-13\r\n`,
		[105],
	],
	["a dated heading with CRLF line ends", "# State\r\n\r\nx\r\n\r\n## 2026-11-13\r\n", [5]],
	["headings without a date", "# State\n\n## Destination\nShip it.\n## Next step\nTest.\n", []],
	["a dated heading inside a code fence", "# State\n\n```\n## 2026-11-13\n```\n", []],
	["exactly 16,384 bytes", `${sixteenKib}\n`, []],
	["16,385 bytes, crossing on line 17", `${sixteenKib}\nx`, [17]],
])("STATE.md with %s", (_case, text, lines) =>
	runTest(
		Effect.gen(function* () {
			const found = yield* problemsOf("STATE.md", text);

			expect(found.lines).toEqual(lines);
		}),
	),
);

test.each([
	[
		"16,383 bytes of text after a 3-byte BOM, crossing on line 16",
		new Uint8Array([239, 187, 191, ...new TextEncoder().encode(sixteenKib)]),
		[16],
	],
	["6,000 bytes that are not UTF-8", new Uint8Array(6000).fill(255), []],
])("STATE.md of %s is measured as on disk", (_case, file, lines) =>
	runTest(
		Effect.gen(function* () {
			const found = yield* problemsIn("STATE.md", file);

			expect(found.lines).toEqual(lines);
		}),
	),
);

test("STATE.md nested deeper than Markdown can read still gets its size checked", () =>
	runTest(
		Effect.gen(function* () {
			const { messages } = yield* problemsOf("STATE.md", `${Str.repeat(20_000)("> ")}## 2026-11-13\n`);

			expect(messages).toContain("40,014 bytes");
			expect(messages).toContain("Markdown cannot read the file");
		}),
	));

test("STATE.md over the cap names its size and the cap", () =>
	runTest(
		Effect.gen(function* () {
			const { messages } = yield* problemsOf("STATE.md", `${sixteenKib}\nx`);

			expect(messages).toContain("16,385 bytes");
			expect(messages).toContain("16,384 bytes");
		}),
	));

const item = (onlyYou: string) =>
	`# Needs\n\n## Merge PR 3\n**The call.** Merge it.\n**My pick.** Merge.\n**What it changes.** Ships.\n**Evidence.** Green.\n**Risk.** Low.\n${onlyYou}`;

test.each([
	["a decision", "**Only you.** A decision. Which plan to buy.\n", []],
	["an approval", "**Only you.** An approval.\n", []],
	["an irreversible action", "**Only you.** an Irreversible action. Deleting the bucket.\n", []],
	["access citing a file in the state folder", "**Only you.** Access. `ruleset.log` records the 403.\n", []],
	["access citing a file under ~/", "**Only you.** Access. `~/denied.log` records the 403.\n", []],
	["access citing an absolute path", `**Only you.** Access. \`${home}/denied.log\` records the 403.\n`, []],
	["no **Only you.** line", "", [3]],
	["a listed **Only you.** line", "- **Only you.** A decision.\n", [9]],
	["an unknown kind", "**Only you.** A preference. I like blue.\n", [9]],
	["a kind that only starts with a known one", "**Only you.** Decisions all round.\n", [9]],
	["access citing a missing file", "**Only you.** Access. `missing.log` records the 403.\n", [9]],
	["access citing a folder", "**Only you.** Access. `.` records the 403.\n", [9]],
	["access citing no file", "**Only you.** Access. The deploy key was refused.\n", [9]],
])("USER_ACTION_ITEMS.md with %s", (_case, onlyYou, lines) =>
	runTest(
		Effect.gen(function* () {
			const found = yield* problemsOf("USER_ACTION_ITEMS.md", item(onlyYou));

			expect(found.lines).toEqual(lines);
		}),
	),
);

test("an unknown kind's problem names the four kinds", () =>
	runTest(
		Effect.gen(function* () {
			const { messages } = yield* problemsOf("USER_ACTION_ITEMS.md", item("**Only you.** A preference.\n"));

			for (const kind of ["decision", "approval", "irreversible action", "access"]) {
				expect(messages).toContain(kind);
			}
		}),
	));

test.each([
	["a relative path, in the state folder", "missing.log", `${folder}/missing.log`],
	["a ~/ path, in home", "~/missing.log", `${home}/missing.log`],
])("a missing cited file at %s shows where it was looked for", (_case, cited, resolved) =>
	runTest(
		Effect.gen(function* () {
			const { messages } = yield* problemsOf(
				"USER_ACTION_ITEMS.md",
				item(`**Only you.** Access. \`${cited}\` shows it.\n`),
			);

			expect(messages).toContain(resolved);
		}),
	),
);

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${home}`.quiet())));
