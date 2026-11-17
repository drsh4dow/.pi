import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { entryKind } from "#src/features/state-folder/index.ts";
import {
	answering,
	compact,
	delegateEnv,
	eventFor,
	ops,
	readA,
	record,
	reply,
	rootEnv,
	run,
	sessionWithTask,
	task,
} from "./session.fixture.ts";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/compaction-test-${String(process.pid)}`;

const anchorRows = [
	{
		name: "a root carries the STATE.md of the state folder it last wrote to",
		env: rootEnv,
		folder: Option.some({ path: `${scratch}/work`, state: Option.some("# Goal\nShip the parser.") }),
		anchor: `<state-file path="${scratch}/work/STATE.md">\n# Goal\nShip the parser.\n</state-file>\n\n`,
	},
	{
		name: "a delegate carries its task message",
		env: delegateEnv,
		folder: Option.none(),
		anchor: `<task>\n${task}\n</task>\n\n`,
	},
	{ name: "a root without a state folder carries no anchor", env: rootEnv, folder: Option.none(), anchor: "" },
	{
		name: "a root whose STATE.md cannot be read carries no anchor",
		env: rootEnv,
		folder: Option.some({ path: `${scratch}/empty`, state: Option.none<string>() }),
		anchor: "",
	},
];

test.each(anchorRows)("$name", (row) =>
	run(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const session = sessionWithTask();

			for (const { path, state } of Option.toArray(row.folder)) {
				session.appendCustomEntry(entryKind, { folder: path });
				yield* fs.makeDirectory(path, { recursive: true });

				for (const text of Option.toArray(state)) {
					yield* fs.writeFileString(`${path}/STATE.md`, text);
				}
			}

			const { summary } = yield* compact(
				row.env,
				eventFor({ session, fileOps: readA }),
				answering(reply({ text: "Narrative." })).ctx,
			);

			expect(summary).toBe(`Narrative.\n\n${row.anchor}<read-files>\nsrc/a.ts\n</read-files>`);
		}),
	),
);

test.each(["manual", "overflow"] as const)("a delegate's %s compaction gets the same summary", (reason) =>
	run(
		Effect.gen(function* () {
			const { summary } = yield* compact(
				delegateEnv,
				eventFor({ session: sessionWithTask(), fileOps: readA, reason }),
				answering(reply({ text: "Narrative." })).ctx,
			);

			expect(summary).toBe(`Narrative.\n\n<task>\n${task}\n</task>\n\n<read-files>\nsrc/a.ts\n</read-files>`);
		}),
	),
);

const fed = (narrative: string) => `<previous-narrative>\n${narrative}\n</previous-narrative>`;

test("three compactions keep the union of their file lists and feed each narrative, alone, to the next", () =>
	run(
		Effect.gen(function* () {
			const session = sessionWithTask();
			const narratives = Arr.map(["one", "two", "three"], (name) => Str.padEnd(11_000, ".")(`Narrative ${name}.`));
			const { prompts, ctx } = answering(...Arr.map(narratives, (text) => reply({ text })));

			const first = yield* compact(
				delegateEnv,
				eventFor({ session, fileOps: ops({ read: ["a.ts"], edited: ["b.ts"] }) }),
				ctx,
			);

			record({ session, entry: first });

			const second = yield* compact(
				delegateEnv,
				eventFor({ session, fileOps: ops({ read: ["c.ts", "b.ts"], written: ["d.ts"] }) }),
				ctx,
			);

			record({ session, entry: second });

			const third = yield* compact(
				delegateEnv,
				eventFor({ session, fileOps: ops({ read: ["e.ts"], edited: ["a.ts"] }) }),
				ctx,
			);

			expect({
				narratives: Arr.map([first, second, third], ({ details }) => details.narrative),
				files: { readFiles: third.details.readFiles, modifiedFiles: third.details.modifiedFiles },
				fedPrior: Arr.map(prompts, (prompt) =>
					Arr.map(Arr.take(narratives, 2), (narrative) => Str.includes(fed(narrative))(prompt)),
				),
			}).toEqual({
				narratives,
				files: { readFiles: ["c.ts", "e.ts"], modifiedFiles: ["a.ts", "b.ts", "d.ts"] },
				fedPrior: [
					[false, false],
					[true, false],
					[false, true],
				],
			});
		}),
	));

afterAll(() =>
	run(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(scratch, { recursive: true, force: true }))),
);
