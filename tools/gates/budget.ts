import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

const budgetFile = "tools/gates/ast-grep-budget.json";
const scanned = ["src", "tools", "agent/extensions", "agent/bin"];

const Match = Schema.Struct({ file: Schema.String, ruleId: Schema.String });
const Budget = Schema.Record(Schema.String, Schema.Int);
const BudgetJson = Schema.fromJsonString(Budget, { space: "\t" });
const MatchJson = Schema.fromJsonString(Match);

type Budget = typeof Budget.Type;

class ScanFailed extends Schema.TaggedError<ScanFailed, { readonly brand: unique symbol }>()("ScanFailed", {
	why: Schema.String,
}) {}

const scan: Effect.Effect<Budget, ScanFailed, ChildProcessSpawner.ChildProcessSpawner> = Effect.scoped(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		const handle = yield* spawner.spawn(
			ChildProcess.make("node_modules/.bin/ast-grep", ["scan", ...scanned, "--json=stream"]),
		);

		const stdout = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString);
		const lines = Arr.filter(Str.split(stdout, "\n"), Str.isNonEmpty);
		const matches = yield* Effect.forEach(lines, (line) => Schema.decodeEffect(MatchJson)(line));

		const keys = Arr.sort(
			Arr.map(matches, ({ file, ruleId }) => `${file} ${ruleId}`),
			Order.String,
		);

		return Record.map(
			Arr.groupBy(keys, (key) => key),
			(group) => group.length,
		);
	}),
).pipe(Effect.mapError((error) => ScanFailed.make({ why: String(error) })));

const differences = (counted: Budget, committed: Budget): ReadonlyArray<string> =>
	Arr.flatMap(Arr.dedupe([...Record.keys(counted), ...Record.keys(committed)]), (key) => {
		const now = counted[key] ?? 0;
		const allowed = committed[key] ?? 0;

		if (now > allowed) {
			return [`${key}: ${now} violations, the budget allows ${allowed}. Fix the new ones.`];
		}

		return now < allowed
			? [
					`${key}: ${now} violations, below the budget of ${allowed}. Run bun tools/gates/budget.ts --write to commit the lower count.`,
				]
			: [];
	});

const write = (counted: Budget): Effect.Effect<void, Schema.SchemaError | Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* Schema.encodeEffect(BudgetJson)(counted);

		yield* fs.writeFileString(budgetFile, `${text}\n`);
	});

const compare = (counted: Budget): Effect.Effect<void, Schema.SchemaError | Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(budgetFile);
		const committed = yield* Schema.decodeEffect(BudgetJson)(text);
		const found = differences(counted, committed);

		if (Arr.isReadonlyArrayNonEmpty(found)) {
			yield* Console.error(Arr.join(found, "\n"));
			process.exitCode = 1;
		}
	});

const program = Effect.flatMap(scan, (counted) =>
	Arr.contains(process.argv, "--write") ? write(counted) : compare(counted),
);

NodeRuntime.runMain(Effect.provide(program, NodeServices.layer));
