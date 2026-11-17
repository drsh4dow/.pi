import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { ContextLabel, labelKey } from "#src/features/loaded/index.ts";
import { type Run, scenario } from "#tools/driver/index.ts";
import { denseFiller, guideLines, guideText, markerOf, plantInWorktree, restores } from "./guide.fixture.ts";
import { compactionsIn, keptHolds } from "./session.fixture.ts";

const model = "ultra-a/claude-fable-5-2";

const name = "scenario-leaf-guide";

const jsonOf = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const Terminals = Schema.Struct({ terminals: Schema.Array(Schema.Struct({ address: Schema.String })) });

const Labelled = Schema.Struct({ labels: Schema.Record(Schema.String, Schema.String) });

const decodeTerminals = Schema.decodeUnknownOption(Schema.fromJsonString(Terminals));

const decodeLabelled = Schema.decodeUnknownOption(Schema.fromJsonString(Labelled));

const decodeLabel = Schema.decodeUnknownOption(Schema.fromJsonString(ContextLabel));

const labels = (run: Run) =>
	Effect.gen(function* () {
		const listed = yield* run.exec(["hc", "ls", "--json"]);
		const terminals = Option.getOrElse(decodeTerminals(listed.output), () => ({ terminals: [] }));

		const shown = yield* Effect.forEach(terminals.terminals, ({ address }) =>
			run.exec(["hc", "get", address, "--json"]),
		);

		return Arr.flatMap(shown, ({ output }) =>
			Option.toArray(
				Option.flatMap(decodeLabelled(output), ({ labels: found }) =>
					Option.flatMap(Option.fromNullishOr(found[labelKey]), decodeLabel),
				),
			),
		);
	});

const labelsFull = (run: Run, path: string) =>
	labels(run).pipe(
		Effect.flatMap((found) =>
			Arr.some(found, ({ loaded }) => Arr.some(loaded, (guide) => guide.path === path && guide.state === "full"))
				? Effect.void
				: Effect.fail("not yet"),
		),
		Effect.retry(Schedule.spaced("1 second")),
		Effect.timeoutOption("3 minutes"),
	);

const leafTask = (files: ReadonlyArray<string>) => [
	"This is a test of context compaction.",
	`1. Use the read tool on ~/.pi/agent/principles/${name}.md with limit 10.`,
	`2. Use the read tool on each of these files, one call per turn, in this order, and write no text between the calls: ${Arr.join(files, ", ")}. Each is in your working folder.`,
	"3. Use the bash tool to run `sleep 30`.",
	`4. Without using any tool, reply with every line of your ${name} principle that starts with \`marker\`, exactly as your context shows them now.`,
];

const startLeaf = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const project = Str.trim((yield* run.exec(["pwd"])).output);
		const files = Arr.makeBy(10, (index) => `filler-${String(index + 1)}.txt`);

		yield* Effect.forEach(files, (file, index) =>
			fs.writeFileString(`${project}/${file}`, `${denseFiller({ seed: `f${String(index)}x`, words: 1500 })}\n`),
		);
		yield* run.root.prompt(
			Arr.join(
				[
					`Use the delegate tool to start one leaf named reader on the model ${model}, then end your turn without waiting for it. Its task message is the following five lines, copied exactly:`,
					...leafTask(files),
				],
				"\n",
			),
		);
	});

const editUnreadLines = (lines: ReadonlyArray<string>, after: string) => [
	...Arr.map(lines, (line, at) => (at >= lines.length - 3 ? `Edited. ${line}` : line)),
	`marker: ${after}`,
];

const holds = (marker: string) => (entry: SessionEntry) =>
	entry.type === "message" && Option.exists(jsonOf(entry.message), Str.includes(marker));

const answerOf = (entries: ReadonlyArray<SessionEntry>) =>
	Arr.findLast(entries, (entry) =>
		entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop"
			? jsonOf(entry.message.content)
			: Option.none(),
	);

const leafSession = (run: Run, what: string, find: (entries: ReadonlyArray<SessionEntry>) => boolean) =>
	run.waitFor(what, "10 minutes", ({ delegates }) =>
		Arr.findFirst(delegates, ({ entries }) => (find(entries) ? Option.some(entries) : Option.none())),
	);

const checkLeaf = (
	run: Run,
	{
		path,
		before,
		after,
		compacted,
	}: {
		readonly path: string;
		readonly before: string;
		readonly after: string;
		readonly compacted: ReadonlyArray<SessionEntry>;
	},
) =>
	Effect.gen(function* () {
		const entries = yield* leafSession(run, "the leaf's answer", (found) =>
			Option.exists(answerOf(found), Str.includes(after)),
		);

		const first = Arr.head(compactionsIn(compacted));
		const all = compactionsIn(entries);

		yield* run.say(`leaf compactions: ${String(all.length)}`);
		yield* run.check(
			Option.isSome(first) && Arr.every(all, ({ summary }) => restores({ summary, path, marker: after })),
			`every leaf summary restores ${path} with the line only the edited file has`,
		);
		yield* run.check(
			Option.exists(answerOf(entries), Str.includes(before)) &&
				Option.exists(first, (last) => !keptHolds({ entries: compacted, last, text: before })),
			"the leaf quotes both marker lines, and no entry pi kept after its first compaction holds the one it read",
		);
	});

const readThenEdit = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const before = yield* markerOf("leaf-before");
		const after = yield* markerOf("leaf-after");
		const lines = [`marker: ${before}`, ...guideLines("leaf")];
		const { file, seen } = yield* plantInWorktree({ run, name, lines });

		yield* startLeaf(run);
		yield* leafSession(run, "the leaf's read of its guide", Arr.some(holds(before)));
		yield* fs.writeFileString(file, guideText({ name, lines: editUnreadLines(lines, after) }));

		return { path: seen, before, after };
	});

scenario({
	model,
	contextWindow: 40_000,
	play: (run) =>
		Effect.scoped(
			Effect.gen(function* () {
				const guide = yield* readThenEdit(run);

				const compacted = yield* leafSession(run, "the leaf's compaction", (entries) =>
					Arr.isReadonlyArrayNonEmpty(compactionsIn(entries)),
				);

				const label = yield* labelsFull(run, guide.path);

				yield* run.check(
					Option.isSome(label),
					`after its compaction the leaf's context label lists ${guide.path} as full`,
				);
				yield* checkLeaf(run, { ...guide, compacted });
			}),
		),
});
