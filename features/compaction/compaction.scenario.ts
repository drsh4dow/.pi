/**
 * On a 40,000-token window, the harness writes every compaction summary itself, in a delegate and in the root. A leaf
 * on a Claude account reads filler until pi compacts it at least three times, then quotes the marker line of its task,
 * which by then reaches it only through the summary. The root's `STATE.md` changes before each of two compactions, and
 * after each the root quotes the new marker without a tool. Every narrative is written, not carried, and under the
 * cap. Without its file lists, the leaf's third summary is at most a tenth longer than its first, and its last file
 * lists still hold the files its first listed. The root's last summary still lists `STATE.md` as modified after the
 * write left the turns it summarized.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, type ScenarioFailed, scenario } from "../../tools/driver/index.ts";
import { carriedNote, Details, narrativeCap } from "./index.ts";

const model = "ultra-a/claude-fable-5-2";

const Compaction = Schema.Struct({
	type: Schema.Literal("compaction"),
	id: Schema.String,
	summary: Schema.String,
	firstKeptEntryId: Schema.String,
	details: Details,
});

type Compaction = typeof Compaction.Type;

const decodeCompaction = Schema.decodeUnknownOption(Compaction);

const jsonOf = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const compactionsIn = (entries: ReadonlyArray<SessionEntry>) =>
	Arr.getSomes(Arr.map(entries, (entry) => decodeCompaction(entry)));

const keptHolds = (entries: ReadonlyArray<SessionEntry>, compaction: Compaction, text: string) => {
	const fromFirst = Arr.dropWhile(entries, (entry) => entry.id !== compaction.firstKeptEntryId);
	const kept = Arr.takeWhile(fromFirst, (entry) => entry.id !== compaction.id);

	return (
		!Arr.isReadonlyArrayNonEmpty(kept) || Arr.some(kept, (entry) => Option.exists(jsonOf(entry), Str.includes(text)))
	);
};

const markerOf = (name: string) =>
	Effect.map(Random.nextIntBetween(1_000_000_000, 9_000_000_000), (value) => `${name}-${value.toString(36)}`);

/** About 10 KB of text that costs the model about four times the tokens pi estimates for it. */
const denseFiller = (seed: string) =>
	Arr.join(
		Arr.makeBy(1500, (index) => `${seed}${index.toString(36)}`),
		" ",
	);

const words = Str.split("the quiet river runs past the old stone mill and the long field of wheat", " ");

/**
 * About 3,000 tokens of plain words, which pi estimates at about what they cost. The root's prompts stay in the
 * messages pi keeps by its estimate, so dense filler there would keep more than the window holds after a compaction.
 */
const plainFiller = Arr.join(
	Arr.makeBy(3000, (index) => words[index % words.length] ?? ""),
	" ",
);

/** A summary without its file lists, which grow by each file the agent touches between compactions. */
const withoutLists = (summary: string) => Str.split("\n\n<read-files>")(summary)[0] ?? summary;

/**
 * Each compaction rewrites the narrative, so two narratives of the same state differ by a few dozen characters either
 * way. A summary that carried the one before it would at least double instead.
 */
const rewordingSlack = 1.1;

const rootEntries = (run: Run) =>
	run.waitFor("the root's session", "10 seconds", ({ root }) => Option.some(root.entries));

const report = (run: Run, who: string, compactions: ReadonlyArray<Compaction>) =>
	Effect.gen(function* () {
		yield* Effect.forEach(compactions, ({ summary, details }, index) =>
			run.say(
				`${who} compaction ${String(index + 1)}: prior narrative ${String(index === 0 ? 0 : (compactions[index - 1]?.details.narrative.length ?? 0))} chars from its entry's details, narrative ${String(details.narrative.length)}, summary ${String(summary.length)}${Str.includes(carriedNote)(summary) ? ", carried" : ""}`,
			),
		);
		yield* run.check(
			Arr.every(
				compactions,
				({ summary, details }) => !Str.includes(carriedNote)(summary) && details.narrative.length <= narrativeCap,
			),
			`every ${who} narrative is written by the model and at most ${String(narrativeCap)} characters`,
		);
	});

const leafTask = (marker: string, files: ReadonlyArray<string>) => [
	`This is a test of context compaction. Your marker line: ${marker}`,
	`Use the read tool on each of these files, one call per turn, in this order, and write no text between the calls: ${Arr.join(files, ", ")}.`,
	"Each is in your working folder. After the last one, without using any tool, reply with only your marker line, exactly as written above.",
];

const startLeaf = (run: Run, project: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const marker = yield* markerOf("leaf-marker");
		const files = Arr.makeBy(10, (index) => `filler-${String(index + 1)}.txt`);

		yield* Effect.forEach(files, (file, index) =>
			fs.writeFileString(`${project}/${file}`, `${denseFiller(`f${String(index)}x`)}\n`),
		);
		yield* run.root.prompt(
			Arr.join(
				[
					"Do these two things, then end your turn without waiting for anything.",
					"1. Use the write tool to create ~/.local/state/pi-agent/demo/work/STATE.md with exactly the line `# Demo`.",
					`2. Use the delegate tool to start one leaf named reader on the model ${model}. Its task message is the following three lines, copied exactly:`,
					...leafTask(marker, files),
				],
				"\n",
			),
		);

		return marker;
	});

const leafDone = (marker: string) => (entries: ReadonlyArray<SessionEntry>) => {
	const answered = Arr.some(
		entries,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason === "stop" &&
			Option.exists(jsonOf(entry.message.content), Str.includes(marker)),
	);

	return compactionsIn(entries).length >= 3 && answered ? Option.some(entries) : Option.none();
};

const bounded = (run: Run, compactions: ReadonlyArray<Compaction>) =>
	Effect.gen(function* () {
		const [first, , third] = compactions;
		const firstSize = withoutLists(first?.summary ?? "").length;
		const thirdSize = third === undefined ? Infinity : withoutLists(third.summary).length;
		const lastRead = compactions.at(-1)?.details.readFiles ?? [];
		const firstRead = first?.details.readFiles ?? [];

		yield* run.check(
			thirdSize <= firstSize * rewordingSlack,
			`without its file lists, the leaf's third summary is at most ${String(rewordingSlack)} times its first (${String(thirdSize)} against ${String(firstSize)})`,
		);
		yield* run.check(
			Arr.isReadonlyArrayNonEmpty(firstRead) && Arr.every(firstRead, (file) => Arr.contains(lastRead, file)),
			`the leaf's last compaction still lists the files its first one listed (${Arr.join(lastRead, ", ")})`,
		);
	});

const leafCompacts = (run: Run, project: string) =>
	Effect.gen(function* () {
		const marker = yield* startLeaf(run, project);

		const leaf = yield* run.waitFor("the leaf's answer after three compactions", "15 minutes", ({ delegates }) =>
			Arr.findFirst(delegates, ({ entries }) => leafDone(marker)(entries)),
		);

		const compactions = compactionsIn(leaf);
		const last = compactions.at(-1);

		yield* report(run, "leaf", compactions);
		yield* bounded(run, compactions);
		yield* run.check(
			Arr.every(compactions, ({ summary }) => Str.includes("<task>")(summary) && Str.includes(marker)(summary)),
			"every leaf summary carries the task message with its marker line",
		);
		yield* run.check(
			last !== undefined && !keptHolds(leaf, last, marker),
			"no entry pi kept after the leaf's last compaction holds its marker, so its answer quotes the summary",
		);
	});

const feed = (run: Run, round: number, before: number, turn: number): Effect.Effect<number, ScenarioFailed> =>
	Effect.gen(function* () {
		yield* run.check(turn < 8, `the root compacts within 8 filler prompts in round ${String(round)}`);
		yield* run.root.prompt(
			`Inert filler for a compaction test, round ${String(round)} turn ${String(turn)}. Reply only ok.\n${plainFiller}`,
		);

		const entries = yield* rootEntries(run);

		return compactionsIn(entries).length > before ? turn + 1 : yield* feed(run, round, before, turn + 1);
	});

const quotes = (
	run: Run,
	{ marker, stateFile, fed }: { readonly marker: string; readonly stateFile: string; readonly fed: number },
) =>
	Effect.gen(function* () {
		const reply = yield* run.root.prompt(
			"Without using any tool, reply with only the marker line of your STATE.md as your context shows it now.",
		);

		const entries = yield* rootEntries(run);
		const last = compactionsIn(entries).at(-1);

		yield* run.check(
			Option.exists(reply, Str.includes(marker)),
			`after ${String(fed)} filler prompts the root compacts and quotes ${marker} (it replied ${Option.getOrElse(reply, () => "nothing")})`,
		);
		yield* run.check(
			last !== undefined &&
				Str.includes(`<state-file path="${stateFile}">`)(last.summary) &&
				Str.includes(marker)(last.summary) &&
				!keptHolds(entries, last, marker),
			`the root's summary carries ${stateFile} with ${marker}, and no entry pi kept holds it`,
		);

		return compactionsIn(entries);
	});

const rootCompacts = (run: Run, round: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const marker = yield* markerOf(`root-marker-${String(round)}`);
		const stateFile = `${run.home}/.local/state/pi-agent/demo/work/STATE.md`;
		const entries = yield* rootEntries(run);

		yield* fs.writeFileString(stateFile, `# Demo\nmarker: ${marker}\n`);

		const fed = yield* feed(run, round, compactionsIn(entries).length, 0);

		return yield* quotes(run, { marker, stateFile, fed });
	});

scenario({
	model,
	contextWindow: 40_000,
	play: (run) =>
		Effect.gen(function* () {
			const project = yield* run.exec(["pwd"]);

			yield* leafCompacts(run, Str.trim(project.output));
			yield* rootCompacts(run, 1);

			const compactions = yield* rootCompacts(run, 2);
			const modified = compactions.at(-1)?.details.modifiedFiles ?? [];

			yield* report(run, "root", compactions);
			yield* run.check(
				Arr.some(modified, Str.endsWith("demo/work/STATE.md")),
				`the root's last compaction still lists STATE.md as modified (it lists ${Arr.join(modified, ", ")})`,
			);
		}),
});
