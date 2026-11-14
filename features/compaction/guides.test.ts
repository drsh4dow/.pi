import { afterAll, expect, test } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Str from "effect/String";

import { guidesOf, indexOf, inContext } from "../loaded/index.ts";
import {
	answering,
	compact,
	delegateEnv,
	eventFor,
	readA,
	readResult,
	record,
	reply,
	run,
	sessionWithTask,
} from "./session.fixture.ts";
import { rereadNote } from "./summary.ts";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/compaction-guides-test-${String(process.pid)}`;

interface Skill {
	readonly path: string;
	readonly text: string;
}

/** A skill file of about `size` characters, every body line its own. */
const skillText = (name: string, size: number) => {
	const line = (at: number) => `Line ${String(at)} of the ${name} guide, long enough to mark it.`;
	const lines = Arr.makeBy(Math.ceil(size / line(0).length), line);

	return Str.slice(0, size)(`---\nname: ${name}\ndescription: The ${name} guide.\n---\n\n${Arr.join(lines, "\n")}\n`);
};

const writeSkill = (name: string, text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = `${scratch}/${name}/SKILL.md`;

		yield* fs.makeDirectory(`${scratch}/${name}`, { recursive: true });
		yield* fs.writeFileString(path, text);

		return { path, text };
	});

const restoredPaths = (summary: string) =>
	Arr.map([...Str.matchAll(/<guide path="(?<path>[^"]+)">/gu)(summary)], ({ groups }) => groups?.["path"] ?? "");

const listedPaths = (summary: string) => {
	const block = /<guides-to-reread>\n(?<block>[^<]*)\n<\/guides-to-reread>/u.exec(summary)?.groups?.["block"] ?? "";

	return Arr.filter(Str.split(block, "\n"), (line) => Str.isNonEmpty(line) && line !== rereadNote);
};

const compactAfterReading = ({
	reason = "threshold",
	read,
	keptReads = [],
	skills,
}: {
	readonly reason?: "threshold" | "overflow" | "manual";
	readonly read: ReadonlyArray<string>;
	readonly keptReads?: ReadonlyArray<string>;
	readonly skills: ReadonlyArray<Skill>;
}) =>
	Effect.gen(function* () {
		const session = sessionWithTask();

		for (const text of read) {
			readResult({ session, text });
		}

		const entry = yield* compact(
			delegateEnv,
			eventFor({ session, fileOps: readA, reason, keptReads }),
			answering(reply({ text: "Narrative." })).ctx,
			Arr.map(skills, ({ path }) => path),
		);

		return { session, entry };
	});

const indexNow = (skills: ReadonlyArray<Skill>) =>
	indexOf(guidesOf(Arr.map(skills, ({ path, text }) => ({ kind: "skill" as const, name: path, path, text }))));

const loadedPaths = (skills: ReadonlyArray<Skill>, session: SessionManager) =>
	Arr.map(
		inContext({ index: indexNow(skills), entries: session.buildSessionProjection().entries }),
		({ path, state }) => ({
			path,
			state,
		}),
	);

const onlySummary = (summary: string) => {
	const session = SessionManager.inMemory("/work");

	session.appendCompaction(summary, "no-kept-entry", 90_000);

	return session;
};

const budgetRows = [
	{
		name: "guides restore in the order they were read until the next passes the budget",
		sizes: [35_000, 35_000, 35_000, 35_000],
		restored: 3,
	},
	{
		name: "after the first guide past the budget, a smaller one is listed too",
		sizes: [100_000, 30_000, 5000],
		restored: 1,
	},
	{ name: "guides that fill the budget exactly all restore", sizes: [60_000, 60_000], restored: 2 },
];

for (const [rowAt, row] of budgetRows.entries()) {
	test(row.name, () =>
		run(
			Effect.gen(function* () {
				const skills = yield* Effect.forEach(row.sizes, (size, at) => {
					const name = `budget-${String(rowAt)}-${String(row.sizes.length - at)}`;

					return writeSkill(name, skillText(name, size));
				});

				const { entry } = yield* compactAfterReading({ read: Arr.map(skills, ({ text }) => text), skills });
				const paths = Arr.map(skills, ({ path }) => path);

				expect({ restored: restoredPaths(entry.summary), listed: listedPaths(entry.summary) }).toEqual({
					restored: Arr.take(paths, row.restored),
					listed: Arr.drop(paths, row.restored),
				});
			}),
		),
	);
}

test("a guide comes back as its file reads at the compaction, and the label shows it loaded", () =>
	run(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const before = skillText("edited", 2000);
			const skill = yield* writeSkill("edited", before);
			const after = `${Str.replace("Line 3 of", "Changed line 3 of")(before)}Only the edited file has this line.\n`;

			yield* fs.writeFileString(skill.path, after);

			const { entry } = yield* compactAfterReading({ read: [before], skills: [skill] });

			expect(entry.summary).toContain(`<guide path="${skill.path}">\n${Str.trimEnd(after)}\n</guide>`);
			expect(loadedPaths([{ ...skill, text: after }], onlySummary(entry.summary))).toEqual([
				{ path: skill.path, state: "full" },
			]);
		}),
	));

test("over a projection that holds only the summary, a restored guide is loaded and a listed one is not", () =>
	run(
		Effect.gen(function* () {
			const restored = yield* writeSkill("label-restored", skillText("label-restored", 100_000));
			const listed = yield* writeSkill("label-listed", skillText("label-listed", 30_000));
			const skills = [restored, listed];
			const { entry } = yield* compactAfterReading({ read: [restored.text, listed.text], skills });

			expect(listedPaths(entry.summary)).toEqual([listed.path]);
			expect(loadedPaths(skills, onlySummary(entry.summary))).toEqual([{ path: restored.path, state: "full" }]);
		}),
	));

test("a guide in the messages pi keeps is neither restored nor listed, and stays loaded", () =>
	run(
		Effect.gen(function* () {
			const dropped = yield* writeSkill("kept-dropped", skillText("kept-dropped", 1000));
			const kept = yield* writeSkill("kept-kept", skillText("kept-kept", 1000));
			const skills = [dropped, kept];

			const { session, entry } = yield* compactAfterReading({
				read: [dropped.text],
				keptReads: [kept.text],
				skills,
			});

			record({ session, entry });

			expect({
				restored: restoredPaths(entry.summary),
				mentionsKept: Str.includes(kept.path)(entry.summary),
			}).toEqual({
				restored: [dropped.path],
				mentionsKept: false,
			});
			expect(loadedPaths(skills, session)).toEqual([
				{ path: dropped.path, state: "full" },
				{ path: kept.path, state: "full" },
			]);
		}),
	));

for (const reason of ["overflow", "manual"] as const) {
	test(`a delegate's ${reason} compaction restores the guide it read`, () =>
		run(
			Effect.gen(function* () {
				const skill = yield* writeSkill(reason, skillText(reason, 1000));
				const { entry } = yield* compactAfterReading({ reason, read: [skill.text], skills: [skill] });

				expect(restoredPaths(entry.summary)).toEqual([skill.path]);
			}),
		));
}

afterAll(() =>
	run(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(scratch, { recursive: true, force: true }))),
);
