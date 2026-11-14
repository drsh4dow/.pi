/**
 * `bun tools/driver/untouched.ts <scenario file>` proves a driver run leaves the human's sessions and state folders
 * alone. It lists every session file under `~/.pi/agent/sessions/` and every file under `~/.local/state/pi-agent/`
 * before and after the run, with its size and change time, which no process can set back. The human's own sessions keep writing meanwhile, so a
 * session file whose header names a session no pi of the run ran, by the run's probe records, is cleared. Every other
 * change counts against the run, however it was made.
 *
 * Exit 0 when nothing counts against the run, 1 when something does, 2 when the check cannot vouch: the scenario printed
 * no `evidence` line, or a session of the run has no probe record, so the probe cannot tell the run's sessions apart.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { probedIn } from "./sessions.ts";

/** The check did not pass: 1 a change counts against the run, 2 the check cannot vouch either way. */
class NotUntouched extends Schema.TaggedError<NotUntouched, { readonly brand: unique symbol }>()("NotUntouched", {
	code: Schema.Literals([1, 2]),
	message: Schema.String,
}) {}

export interface Change {
	readonly kind: "new" | "changed" | "deleted";
	readonly path: string;
}

/** Pure. Each file that is new, changed or gone in `after`. Both map a path to its size and change time. */
export const changesOf = ({
	before,
	after,
}: {
	readonly before: ReadonlyMap<string, string>;
	readonly after: ReadonlyMap<string, string>;
}) =>
	Arr.flatMap(Arr.dedupe([...before.keys(), ...after.keys()]), (path): ReadonlyArray<Change> => {
		if (!before.has(path)) {
			return [{ kind: "new", path }];
		}

		if (!after.has(path)) {
			return [{ kind: "deleted", path }];
		}

		return before.get(path) === after.get(path) ? [] : [{ kind: "changed", path }];
	});

/**
 * Pure. Each change, cleared only when `headers` holds the session id the file's header named after the run and no pi
 * of the run recorded that session as its own.
 */
export const judge = (input: {
	readonly changes: ReadonlyArray<Change>;
	readonly headers: ReadonlyMap<string, string>;
	readonly recorded: ReadonlySet<string>;
}) =>
	Arr.map(input.changes, (change) => {
		const session = Option.fromUndefinedOr(input.headers.get(change.path));

		return { ...change, session, cleared: Option.exists(session, (id) => !input.recorded.has(id)) };
	});

/** Each file `find <args>` matches, by path, with its size and change time. A missing folder lists nothing. */
const found = Effect.fn("found")(function* (args: ReadonlyArray<string>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const format = String.raw`%s %C@ %p\0`;

	const handle = yield* spawner.spawn(
		ChildProcess.make("find", [...args, "!", "-type", "d", "-printf", format], { stderr: "ignore" }),
	);

	const text = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString);
	const entries = Arr.filter(Str.split(text, "\0"), Str.isNonEmpty);

	return new Map(
		Arr.map(entries, (entry) => {
			const [size, changed, ...path] = Str.split(entry, " ");

			return [Arr.join(path, " "), `${size ?? ""} ${changed ?? ""}`];
		}),
	);
}, Effect.scoped);

/** Runs the scenario, streaming its output, and returns its exit code and its `evidence` folder. */
const runScenario = Effect.fn("runScenario")(function* (scenario: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	const handle = yield* spawner.spawn(ChildProcess.make("bun", [scenario], { stdin: "ignore", stderr: "inherit" }));

	const output = yield* handle.stdout.pipe(
		Stream.decodeText,
		Stream.tap((text) => Effect.sync(() => process.stdout.write(text))),
		Stream.mkString,
	);

	const code = yield* handle.exitCode;
	const evidence = Option.fromNullishOr(/^evidence (?<folder>.+)$/mu.exec(output)?.groups?.["folder"]);

	return { code, evidence };
}, Effect.scoped);

const Header = Schema.Struct({ type: Schema.Literal("session"), id: Schema.String });

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));

/** The session id in a session file's header line, when the file exists and starts with one. */
const sessionOf = (file: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.readFileString(file).pipe(
			Effect.map((text) => decodeHeader(Str.split(text, "\n")[0] ?? "")),
			Effect.map(Option.map(({ id }) => id)),
			Effect.orElseSucceed(Option.none<string>),
		),
	);

/** Every `*.jsonl` file under `folder`, none when it is missing. */
const jsonlUnder = (folder: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.readDirectory(folder, { recursive: true }).pipe(
			Effect.map((names) => Arr.map(Arr.filter(names, Str.endsWith(".jsonl")), (name) => `${folder}/${name}`)),
			Effect.orElseSucceed((): ReadonlyArray<string> => []),
		),
	);

/** The session ids the run's probe recorded, and the run's own sessions missing among them. */
const runSessionsOf = Effect.fn("runSessionsOf")(function* (evidence: string) {
	const fs = yield* FileSystem.FileSystem;
	const probeFiles = yield* jsonlUnder(`${evidence}/probe`);
	const probes = yield* Effect.forEach(probeFiles, (file) => fs.readFileString(file));
	const recorded = new Set(Arr.map(Arr.flatMap(probes, probedIn), (record) => record.session));
	const ownFiles = yield* jsonlUnder(`${evidence}/sessions`);
	const own = yield* Effect.forEach(ownFiles, sessionOf);

	return { recorded, unrecorded: Arr.filter(Arr.getSomes(own), (id) => !recorded.has(id)) };
});

/** Runs the scenario between two listings of the human's folders. */
const observed = Effect.fn("observed")(function* (scenario: string) {
	const home = yield* Config.String("HOME");
	const sessions = `${home}/.pi/agent/sessions`;

	const listing = Effect.zipWith(
		found([sessions, "-name", "*.jsonl"]),
		found([`${home}/.local/state/pi-agent`]),
		(sessionFiles, stateFiles) => new Map([...sessionFiles, ...stateFiles]),
	);

	const before = yield* listing;
	const run = yield* runScenario(scenario);
	const after = yield* listing;

	return { sessions, before, after, run };
});

type Judged = ReturnType<typeof judge>[number];

/** Pure. The report's lines and the outcome. */
const reportOf = (input: {
	readonly listed: readonly [number, number];
	readonly scenarioExit: number;
	readonly judged: ReadonlyArray<Judged>;
	readonly unrecorded: ReadonlyArray<string>;
}) => {
	const against = Arr.filter(input.judged, (change) => !change.cleared);
	const vouches = Arr.isReadonlyArrayEmpty(input.unrecorded) ? "yes" : "cannot vouch";
	const outcome = Arr.isReadonlyArrayNonEmpty(against) ? "no" : vouches;

	const line = ({ kind, path, session, cleared }: Judged) =>
		cleared
			? `  ${kind} ${path}  cleared, session ${Option.getOrElse(session, () => "")} is not the run's`
			: `  ${kind} ${path}  counts against the run`;

	const lines = [
		`listed ${String(input.listed[0])} files before the run, ${String(input.listed[1])} after`,
		`scenario exit ${String(input.scenarioExit)}`,
		`changed files: ${String(input.judged.length)}`,
		...Arr.map(input.judged, line),
		`run sessions with no probe record: ${String(input.unrecorded.length)}`,
		...Arr.map(input.unrecorded, (id) => `  ${id}`),
		`untouched ${outcome}`,
	];

	return { text: Arr.join(lines, "\n"), outcome };
};

/** Each change in the human's folders, judged against the sessions the run's probe recorded. */
const judgedRun = Effect.fn("judgedRun")(function* (
	seen: Effect.Success<ReturnType<typeof observed>>,
	evidence: string,
) {
	const { recorded, unrecorded } = yield* runSessionsOf(evidence);
	const changes = changesOf(seen);
	const sessionFiles = Arr.filter(changes, ({ path }) => Str.startsWith(`${seen.sessions}/`)(path));

	const headers = yield* Effect.forEach(sessionFiles, ({ path }) =>
		Effect.map(
			sessionOf(path),
			Option.map((id) => [path, id] as const),
		),
	);

	const judged = judge({ changes, headers: new Map(Arr.getSomes(headers)), recorded });

	return reportOf({ listed: [seen.before.size, seen.after.size], scenarioExit: seen.run.code, judged, unrecorded });
});

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const seen = yield* observed(process.argv[2] ?? "");

	if (Option.isNone(seen.run.evidence)) {
		return yield* NotUntouched.make({
			code: 2,
			message: `the scenario printed no evidence line, exit ${String(seen.run.code)}`,
		});
	}

	const { text, outcome } = yield* judgedRun(seen, seen.run.evidence.value);

	yield* Console.log(text);
	yield* fs.writeFileString(`${seen.run.evidence.value}/untouched.txt`, `${text}\n`);

	return outcome === "yes"
		? undefined
		: yield* NotUntouched.make({ code: outcome === "no" ? 1 : 2, message: `untouched ${outcome}` });
});

const exitCode: Runtime.Teardown = (exit, onExit) => {
	if (Exit.isSuccess(exit)) {
		onExit(0);

		return;
	}

	const failure = Option.filter(Cause.findErrorOption(exit.cause), Schema.is(NotUntouched));

	onExit(Option.match(failure, { onSome: ({ code }) => code, onNone: () => 2 }));
};

if (import.meta.main) {
	NodeRuntime.runMain(Effect.provide(program, NodeServices.layer), { teardown: exitCode });
}
