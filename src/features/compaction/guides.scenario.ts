import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { guideFilesIn, inContext, loadGuides } from "#src/features/loaded/index.ts";
import { type Run, type ScenarioFailed, scenario } from "#tools/driver/index.ts";
import { denseFiller, guideLines, markerOf, plantInWorktree, restores } from "./guide.fixture.ts";
import { compactionsIn, keptHolds } from "./session.fixture.ts";

const window = 40_000;

interface Guide {
	readonly path: string;
	readonly marker: string;
}

const plainWords = Str.split("the quiet river runs past the old stone mill and the long field of wheat", " ");

const plainFiller = Arr.join(
	Arr.makeBy(3000, (index) => plainWords[index % plainWords.length] ?? ""),
	" ",
);

const rootEntries = (run: Run) =>
	run.waitFor("the root's session", "10 seconds", ({ root }) => Option.some(root.entries));

const compactionCount = (run: Run) => Effect.map(rootEntries(run), (entries) => compactionsIn(entries).length);

const projectedLabelLists = (run: Run, entries: ReadonlyArray<SessionEntry>, guide: Guide) =>
	Effect.gen(function* () {
		const principles = yield* guideFilesIn("principle", `${run.home}/.pi/agent/principles`);
		const playbooks = yield* guideFilesIn("playbook", `${run.home}/.pi/agent/playbooks`);
		const index = yield* loadGuides([...principles, ...playbooks]);
		const loaded = inContext({ index, entries: buildSessionProjection([...entries]).entries });

		return Arr.some(loaded, ({ path, state }) => path === guide.path && state === "full");
	});

const quotes = (run: Run, kind: string, guide: Guide) =>
	Effect.gen(function* () {
		const compacted = yield* rootEntries(run);
		const last = compactionsIn(compacted).at(-1);

		const reply = yield* run.root.prompt(
			"Without using any tool, reply with only the line of your scenario-root-guide principle that starts with `marker:`, exactly as your context shows it now.",
		);

		const entries = yield* rootEntries(run);
		const labelled = yield* projectedLabelLists(run, entries, guide);

		yield* run.check(
			last !== undefined &&
				restores({ summary: last.summary, ...guide }) &&
				!keptHolds({ entries, last, text: guide.marker }),
			`the root's ${kind} summary restores ${guide.path} with ${guide.marker}, and no entry pi kept holds it`,
		);
		yield* run.check(
			Option.exists(reply, Str.includes(guide.marker)),
			`after the ${kind} compaction the root quotes ${guide.marker} (it replied ${Option.getOrElse(reply, () => "nothing")})`,
		);
		yield* run.check(labelled, `after the ${kind} compaction the root's context label lists ${guide.path} as full`);
	});

const feed = (run: Run, before: number, turn: number): Effect.Effect<void, ScenarioFailed> =>
	Effect.gen(function* () {
		yield* run.check(turn < 8, "the root compacts at its threshold within 8 filler prompts");
		yield* run.root.prompt(
			`Inert filler for a compaction test, turn ${String(turn)}. Reply only ok.\n${plainFiller}`,
		);

		const count = yield* compactionCount(run);

		return count > before ? undefined : yield* feed(run, before, turn + 1);
	});

const overflow = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const before = yield* compactionCount(run);

		yield* run.root.prompt(
			`Inert filler for a compaction test. Reply only ok.\n${denseFiller({ seed: "ovx", words: 12_000 })}`,
		);

		const after = yield* compactionCount(run);
		const events = yield* fs.readFileString(`${Str.slice(0, -"/home".length)(run.home)}/root.out.jsonl`);

		yield* run.check(
			after > before && Str.includes(`"type":"compaction_start","reason":"overflow"`)(events),
			"the dense prompt made pi compact for overflow",
		);
	});

const manual = (run: Run) =>
	Effect.gen(function* () {
		yield* run.root.prompt(`Inert filler for a compaction test. Reply only ok.\n${plainFiller}`);
		yield* run.root.prompt(`Inert filler for a compaction test. Reply only ok.\n${plainFiller}`);

		const before = yield* compactionCount(run);

		yield* run.root.compact;

		const after = yield* compactionCount(run);

		yield* run.check(after > before, "the manual compaction wrote a compaction entry");
	});

const readGuide = (run: Run) =>
	Effect.gen(function* () {
		const marker = yield* markerOf("root-marker");
		const lines = [`marker: ${marker}`, ...guideLines("root")];
		const { seen } = yield* plantInWorktree({ run, name: "scenario-root-guide", lines });

		yield* run.root.prompt("Use the read tool on ~/.pi/agent/principles/scenario-root-guide.md, then reply only ok.");

		return { path: seen, marker };
	});

scenario({
	model: "ultra-a/claude-fable-5-2",
	contextWindow: window,
	play: (run) =>
		Effect.scoped(
			Effect.gen(function* () {
				const guide = yield* readGuide(run);
				const start = yield* compactionCount(run);

				yield* feed(run, start, 0);
				yield* quotes(run, "threshold", guide);
				yield* overflow(run);
				yield* quotes(run, "overflow", guide);
				yield* manual(run);
				yield* quotes(run, "manual", guide);
			}),
		),
});
