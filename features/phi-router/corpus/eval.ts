/**
 * `bun features/phi-router/corpus/eval.ts [--corpus <manifest.jsonl>] --judge live|recorded [--record]
 * [--window N | --sweep 0,1,2,4]` plays a corpus through the router core and prints, per stratum, the positive cases
 * whose complete canary reached a personal account, then over-routing, fragments, lanes and judge cost. Without
 * `--corpus` it plays the default generated corpus. `--sweep` runs once per judge window and prints one row per size.
 *
 * It exits non-zero on an unrecorded call in recorded mode, on a manifest line that does not decode, and, for one
 * window, on any leak among in-policy positive cases. `--record`, with `live` only, rewrites `recordings.jsonl` with the
 * run's answers.
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

import { Judge } from "../policy/engine.ts";
import { window as policyWindow } from "../policy/policy.ts";
import { evaluate } from "./evaluate.ts";
import { defaultSeed, generate } from "./generate.ts";
import { decodeJsonLines } from "./jsonl.ts";
import { judgeOn, liveClassify } from "./live.ts";
import { CaseFromJsonLine } from "./manifest.ts";
import { recordedJudge, recording, recordingsPath } from "./recorded.ts";
import { categoryTable, outputOf } from "./render.ts";
import type { Report } from "./report.ts";

class Usage extends Schema.TaggedError<Usage, { readonly brand: unique symbol }>()("Usage", {
	message: Schema.String,
}) {}

class GateFailed extends Schema.TaggedError<GateFailed, { readonly brand: unique symbol }>()("GateFailed", {
	message: Schema.String,
}) {}

const usage =
	"usage: bun features/phi-router/corpus/eval.ts [--corpus <manifest.jsonl>] --judge live|recorded [--record] [--window N | --sweep 0,1,2,4]";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Window = Schema.FiniteFromString.pipe(Schema.decodeTo(NonNegativeInt));

const Args = Schema.Struct({
	corpus: Schema.optionalKey(Schema.String),
	judge: Schema.Literals(["live", "recorded"]),
	record: Schema.optionalKey(Schema.Boolean),
	window: Schema.optionalKey(Window),
	sweep: Schema.optionalKey(Schema.String),
});

const decodeArgs = Schema.decodeUnknownEffect(Args);

const decodeWindows = Schema.decodeUnknownEffect(Schema.NonEmptyArray(Window));

const valued = new Set(["--corpus", "--judge", "--window", "--sweep"]);

/** `--record` alone, every other flag with its value. None for an unknown flag or a missing value. */
const flagsOf = (
	[flag, ...rest]: ReadonlyArray<string>,
	flags: Readonly<Record<string, string | boolean>> = {},
): Option.Option<Readonly<Record<string, string | boolean>>> => {
	if (flag === undefined) {
		return Option.some(flags);
	}

	if (flag === "--record") {
		return flagsOf(rest, { ...flags, record: true });
	}

	const [value, ...after] = rest;

	if (!valued.has(flag) || value === undefined) {
		return Option.none();
	}

	return flagsOf(after, { ...flags, [Str.slice(2)(flag)]: value });
};

const windowsOf = ({ window, sweep }: typeof Args.Type) =>
	sweep === undefined ? Effect.succeed([window ?? policyWindow]) : decodeWindows(Str.split(",")(sweep));

const argsOf = Effect.fn("argsOf")(
	function* (argv: ReadonlyArray<string>) {
		const flags = yield* Effect.fromOption(flagsOf(argv));
		const args = yield* decodeArgs(flags);

		if ((args.record === true && args.judge !== "live") || (args.window !== undefined && args.sweep !== undefined)) {
			return yield* Effect.fail("conflicting flags");
		}

		const windows = yield* windowsOf(args);

		return { corpus: Option.fromUndefinedOr(args.corpus), judge: args.judge, record: args.record === true, windows };
	},
	Effect.mapError(() => Usage.make({ message: usage })),
);

type Args = Effect.Success<ReturnType<typeof argsOf>>;

const casesOf = Effect.fn("casesOf")(function* (corpus: Args["corpus"]) {
	if (Option.isNone(corpus)) {
		return generate(defaultSeed);
	}

	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(corpus.value);

	return yield* decodeJsonLines({ schema: CaseFromJsonLine, source: corpus.value, text });
});

/** The judge for the run, and what it leaves to check or write once every window has run. */
const judgeFor = Effect.fn("judgeFor")(function* (args: Args) {
	const fs = yield* FileSystem.FileSystem;

	if (args.judge === "recorded") {
		const replay = yield* Effect.flatMap(fs.readFileString(recordingsPath), recordedJudge);

		return { judge: replay.judge, unrecorded: replay.unrecorded, finish: Effect.void };
	}

	const live = yield* Effect.flatMap(liveClassify, judgeOn);

	if (!args.record) {
		return { judge: live, unrecorded: Effect.succeed(0), finish: Effect.void };
	}

	const recorder = recording(live);
	const finish = Effect.flatMap(recorder.contents, (contents) => fs.writeFileString(recordingsPath, contents));

	return { judge: recorder.judge, unrecorded: Effect.succeed(0), finish };
});

/** A sweep measures each size, so only one window's leaks fail the run; an unrecorded call always does. */
const gate = ({ reports, unrecorded }: { readonly reports: ReadonlyArray<Report>; readonly unrecorded: number }) => {
	const leaks = Arr.reduce(reports, 0, (total, report) => total + report.leaks.length);
	const message = `${String(leaks)} leaked in-policy case(s), ${String(unrecorded)} unrecorded judge call(s)`;
	const gated = unrecorded > 0 || (reports.length === 1 && leaks > 0);

	return gated ? Effect.fail(GateFailed.make({ message })) : Effect.void;
};

const program = Effect.gen(function* () {
	const args = yield* argsOf(Arr.drop(process.argv, 2));
	const cases = yield* casesOf(args.corpus);
	const run = yield* judgeFor(args);
	const evaluated = (window: number) => Effect.provideService(evaluate({ cases, window }), Judge, run.judge);
	const reports = yield* Effect.forEach(args.windows, evaluated);

	yield* run.finish;

	const unrecorded = yield* run.unrecorded;
	const recorded = args.judge === "recorded" ? [`unrecorded judge calls ${String(unrecorded)}`] : [];

	yield* Console.log(Arr.join([outputOf(reports), "", categoryTable, ...recorded], "\n"));

	return yield* gate({ reports, unrecorded });
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
