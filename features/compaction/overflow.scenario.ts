/**
 * An overflow compaction carries the harness's summary to the call pi retries. The root runs on a model whose real
 * window is 200,000 tokens with no reserve, so pi never compacts at its threshold: it compacts only when the provider
 * refuses a request as too long, then retries it. Its `STATE.md` changes before the overflow, and afterwards the root
 * quotes the new marker without a tool, from a summary whose narrative the model wrote.
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

const compactionIn = (entries: ReadonlyArray<SessionEntry>) =>
	Arr.findFirst(entries, (entry) => decodeCompaction(entry));

const refusedIn = (entries: ReadonlyArray<SessionEntry>) =>
	Arr.some(
		entries,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason === "error" &&
			/too long|context/iu.test(entry.message.errorMessage ?? ""),
	);

const keptHolds = (entries: ReadonlyArray<SessionEntry>, compaction: Compaction, text: string) => {
	const fromFirst = Arr.dropWhile(entries, (entry) => entry.id !== compaction.firstKeptEntryId);
	const kept = Arr.takeWhile(fromFirst, (entry) => entry.id !== compaction.id);

	return (
		!Arr.isReadonlyArrayNonEmpty(kept) || Arr.some(kept, (entry) => Option.exists(jsonOf(entry), Str.includes(text)))
	);
};

const rootEntries = (run: Run) =>
	run.waitFor("the root's session", "10 seconds", ({ root }) => Option.some(root.entries));

/** About 45 KB, under the read tool's 50 KB cut, of text dense in tokens. */
const filler = (seed: number) =>
	Arr.join(
		Arr.makeBy(4500, (index) => Str.padStart(9, "q")((index * 7919 + seed * 104_729).toString(36))),
		" ",
	);

const feed = (
	run: Run,
	project: string,
	turn: number,
): Effect.Effect<ReadonlyArray<SessionEntry>, ScenarioFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const file = `${project}/dense-${String(turn)}.txt`;

		yield* run.check(turn < 16, "the root compacts within 16 files of filler");
		yield* fs.writeFileString(file, `${filler(turn)}\n`).pipe(Effect.orDie);
		yield* run.root.prompt(`Use the read tool on ${file}, then reply only ok.`);

		const entries = yield* rootEntries(run);

		return Option.isSome(compactionIn(entries)) ? entries : yield* feed(run, project, turn + 1);
	});

const checkSummary = (
	run: Run,
	{
		compaction,
		stateFile,
		marker,
	}: { readonly compaction: Compaction; readonly stateFile: string; readonly marker: string },
) =>
	Effect.gen(function* () {
		yield* run.say(
			`overflow compaction: narrative ${String(compaction.details.narrative.length)} chars, summary ${String(compaction.summary.length)}`,
		);
		yield* run.check(
			!Str.includes(carriedNote)(compaction.summary) && compaction.details.narrative.length <= narrativeCap,
			`the overflow summary holds a written narrative of at most ${String(narrativeCap)} characters`,
		);
		yield* run.check(
			Str.includes(`<state-file path="${stateFile}">`)(compaction.summary) &&
				Str.includes(marker)(compaction.summary),
			`the overflow summary carries ${stateFile} with ${marker}`,
		);
	});

/** Has the root write `STATE.md` in a state folder, then puts a marker line in it that the root never saw. */
const withStateFile = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const value = yield* Random.nextIntBetween(1_000_000_000, 9_000_000_000);
		const marker = `overflow-marker-${value.toString(36)}`;
		const stateFile = `${run.home}/.local/state/pi-agent/demo/work/STATE.md`;

		yield* run.root.prompt(
			"Use the write tool to create ~/.local/state/pi-agent/demo/work/STATE.md with exactly the line `# Demo`, then reply only ok.",
		);
		yield* fs.writeFileString(stateFile, `# Demo\nmarker: ${marker}\n`);

		return { marker, stateFile };
	});

const quotes = (
	run: Run,
	{
		fed,
		compaction,
		marker,
	}: { readonly fed: ReadonlyArray<SessionEntry>; readonly compaction: Compaction; readonly marker: string },
) =>
	Effect.gen(function* () {
		const reply = yield* run.root.prompt(
			"Without using any tool, reply with only the marker line of your STATE.md as your context shows it now.",
		);

		yield* run.check(
			Option.exists(reply, Str.includes(marker)) && !keptHolds(fed, compaction, marker),
			`the root quotes ${marker} after the overflow compaction, and no entry pi kept holds it (it replied ${Option.getOrElse(reply, () => "nothing")})`,
		);
	});

scenario({
	model: "ultra-a/claude-haiku-4-5",
	settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 } },
	play: (run) =>
		Effect.gen(function* () {
			const project = yield* run.exec(["pwd"]);
			const { marker, stateFile } = yield* withStateFile(run);
			const fed = yield* feed(run, Str.trim(project.output), 0);
			const compaction = yield* run.waitFor("the compaction", "1 second", () => compactionIn(fed));

			yield* run.check(refusedIn(fed), "the provider refused a request as too long, so pi compacted for overflow");
			yield* checkSummary(run, { compaction, stateFile, marker });

			yield* quotes(run, { fed, compaction, marker });
		}),
});
