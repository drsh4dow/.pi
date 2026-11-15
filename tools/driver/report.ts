import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** Prints to stdout and appends to `report.txt`, and counts seconds from the run's start. */
export const reporter = Effect.fn("reporter")(function* (report: string) {
	const fs = yield* FileSystem.FileSystem;
	const started = yield* Clock.currentTimeMillis;
	const elapsed = Effect.map(Clock.currentTimeMillis, (now) => Math.round((now - started) / 1000));

	const say = (value: Schema.Json) =>
		Effect.gen(function* () {
			const line = Predicate.isString(value) ? value : yield* encodeLine(value);

			yield* Console.log(line);
			yield* fs.writeFileString(report, `${line}\n`, { flag: "a" });
		}).pipe(Effect.orDie);

	const progress = (what: string) => Effect.flatMap(elapsed, (seconds) => say(`  ${String(seconds)} s  ${what}`));

	return { say, progress, elapsed };
});

export type Reporter = Effect.Success<ReturnType<typeof reporter>>;
