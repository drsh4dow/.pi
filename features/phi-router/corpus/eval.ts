/**
 * `bun features/phi-router/corpus/eval.ts <manifest.jsonl> --judge live|recorded [--record]` runs the policy engine
 * over a corpus manifest and prints misses per stratum with their 95% upper bounds, the missed cases, over-routing and
 * the judge's latency. It exits non-zero on any miss, on any unrecorded call in recorded mode, and on a manifest line
 * that does not decode. `--record`, with `live` only, rewrites `recordings.jsonl` from the run's answers.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { Judge } from "../policy/index.ts";
import { evaluate, type Report } from "./evaluate.ts";
import { decodeJsonLines } from "./jsonl.ts";
import { judgeOn, liveClassify } from "./live.ts";
import { type Case, CaseFromJsonLine } from "./manifest.ts";
import { recordedJudge, recording, recordingsPath } from "./recorded.ts";

type Mode = "live" | "live-record" | "recorded";

const modes = new Map<string, Mode>([
	["--judge live", "live"],
	["--judge live --record", "live-record"],
	["--record --judge live", "live-record"],
	["--judge recorded", "recorded"],
]);

class Usage extends Schema.TaggedError<Usage, { readonly brand: unique symbol }>()("Usage", {
	message: Schema.String,
}) {}

class GateFailed extends Schema.TaggedError<GateFailed, { readonly brand: unique symbol }>()("GateFailed", {
	message: Schema.String,
}) {}

const usage = "usage: bun features/phi-router/corpus/eval.ts <manifest.jsonl> --judge live|recorded [--record]";

const argsOf = ([manifest, ...flags]: ReadonlyArray<string>) => {
	const mode = modes.get(Arr.join(flags, " "));

	if (manifest === undefined || Str.startsWith("-")(manifest) || mode === undefined) {
		return Effect.fail(Usage.make({ message: usage }));
	}

	return Effect.succeed({ manifest, mode });
};

interface Judged {
	readonly report: Report;
	readonly unrecorded: Option.Option<number>;
}

const recordedRun = Effect.fn("recordedRun")(function* (cases: ReadonlyArray<Case>) {
	const fs = yield* FileSystem.FileSystem;
	const contents = yield* fs.readFileString(recordingsPath);
	const replay = yield* recordedJudge(contents);
	const report = yield* evaluate(cases).pipe(Effect.provideService(Judge, replay.judge));
	const unrecorded = yield* replay.unrecorded;

	return { report, unrecorded: Option.some(unrecorded) } satisfies Judged;
});

const liveRun = Effect.fn("liveRun")(function* (cases: ReadonlyArray<Case>) {
	const live = yield* Effect.flatMap(liveClassify, judgeOn);
	const report = yield* evaluate(cases).pipe(Effect.provideService(Judge, live));

	return { report, unrecorded: Option.none() } satisfies Judged;
});

const recordRun = Effect.fn("recordRun")(function* (cases: ReadonlyArray<Case>) {
	const fs = yield* FileSystem.FileSystem;
	const live = yield* Effect.flatMap(liveClassify, judgeOn);
	const recorder = yield* recording(live);
	const report = yield* evaluate(cases).pipe(Effect.provideService(Judge, recorder.judge));
	const contents = yield* recorder.contents;

	yield* fs.writeFileString(recordingsPath, contents);

	return { report, unrecorded: Option.none() } satisfies Judged;
});

const runs = { live: liveRun, "live-record": recordRun, recorded: recordedRun } as const;

interface Table {
	readonly header: ReadonlyArray<string>;
	readonly labels: number;
	readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

const table = ({ header, labels, rows }: Table) => {
	const widths = Arr.map(header, (title, column) =>
		Math.max(title.length, ...Arr.map(rows, (row) => (row[column] ?? "").length)),
	);

	const cellOf = (cell: string, column: number) => {
		const width = widths[column] ?? 0;

		return column < labels ? Str.padEnd(width)(cell) : Str.padStart(width)(cell);
	};

	const line = (row: ReadonlyArray<string>) => Str.trimEnd(Arr.join(Arr.map(row, cellOf), "  "));

	return Arr.join(Arr.map([header, ...rows], line), "\n");
};

const rate = (part: number, whole: number) => (whole === 0 ? "-" : (part / whole).toFixed(4));

const ms = (value: Option.Option<number>) =>
	Option.match(value, { onNone: () => "-", onSome: (took) => `${Math.round(took)} ms` });

const strataTable = ({ strata }: Report) =>
	table({
		header: ["axis", "value", "N", "misses", "uncertain", "upper95"],
		labels: 2,
		rows: Arr.map(strata, (row) => [
			row.axis,
			row.value,
			String(row.cases),
			String(row.misses),
			String(row.uncertain),
			row.missRateUpper95.toFixed(4),
		]),
	});

const missTable = ({ misses }: Report) =>
	misses.length === 0
		? "Missed cases: none"
		: table({
				header: ["missed case", "identifier", "carrier", "transform", "entry"],
				labels: 5,
				rows: Arr.map(misses, ({ id, strata }) => [
					id,
					strata.identifier,
					strata.carrier,
					strata.transform,
					strata.entry,
				]),
			});

const overRoutingTable = ({ overRouting, totals }: Report) =>
	table({
		header: ["negative", "N", "over-routed", "rate"],
		labels: 1,
		rows: [
			...Arr.map(overRouting, (row) => [
				row.negative,
				String(row.cases),
				String(row.overRouted),
				rate(row.overRouted, row.cases),
			]),
			["all", String(totals.clean), String(totals.overRouted), rate(totals.overRouted, totals.clean)],
		],
	});

const render = ({ report, unrecorded }: Judged) => {
	const { totals, judge } = report;

	return Arr.join(
		[
			"Misses per stratum, with the one-sided Clopper-Pearson 95% upper bound on the miss rate",
			strataTable(report),
			"",
			missTable(report),
			"",
			"Over-routing: clean cases that did not come back Clean",
			overRoutingTable(report),
			"",
			`phi cases ${totals.phi}: caught ${totals.phi - totals.misses}, missed ${totals.misses}, uncertain ${totals.uncertain}`,
			`clean cases ${totals.clean}: over-routed ${totals.overRouted}`,
			`judge calls ${judge.calls}: p50 ${ms(judge.p50Ms)}, p95 ${ms(judge.p95Ms)}`,
			...Option.match(unrecorded, { onNone: () => [], onSome: (count) => [`unrecorded judge calls ${count}`] }),
		],
		"\n",
	);
};

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const { manifest, mode } = yield* argsOf(Arr.drop(process.argv, 2));
	const text = yield* fs.readFileString(manifest);
	const cases = yield* decodeJsonLines({ schema: CaseFromJsonLine, source: manifest, text });
	const judged = yield* runs[mode](cases);
	const { misses } = judged.report.totals;
	const unrecorded = Option.getOrElse(judged.unrecorded, () => 0);
	const message = `${misses} missed PHI case(s), ${unrecorded} unrecorded judge call(s)`;

	yield* Console.log(render(judged));

	return yield* misses > 0 || unrecorded > 0 ? Effect.fail(GateFailed.make({ message })) : Effect.void;
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
