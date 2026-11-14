/**
 * `bun tools/driver/untouched.ts <scenario file>` proves a driver run leaves the human's sessions and state folders
 * alone. The human's live sessions keep writing to those folders meanwhile, so a before-and-after listing alone cannot
 * tell who changed a file. This traces the run's whole process tree and attributes every change.
 *
 * Exit 0 when the run changed nothing under `~/.pi/` or `~/.local/state/` beyond pi's `auth.json` lock and connected
 * to no other terminal core, 1 when it did, 2 when the check cannot vouch: no `evidence` line, a write strace could not
 * place, or a run session file the trace never saw written. The scenario's own exit is reported, not judged.
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

import { judge, type Traced, traced, type Verdict, writesIn } from "./trace.ts";

/** The check did not pass: 1 the run touched the human's folders, 2 the check cannot vouch either way. */
class NotUntouched extends Schema.TaggedError<NotUntouched, { readonly brand: unique symbol }>()("NotUntouched", {
	code: Schema.Literals([1, 2]),
	message: Schema.String,
}) {}

/** Every file under the human's sessions and state folders, by path, with its size and mtime. */
const listing = Effect.fn("listing")(function* (home: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const format = String.raw`%p\t%s\t%T@\n`;

	const handle = yield* spawner.spawn(
		ChildProcess.make(
			"find",
			[`${home}/.pi/agent/sessions`, `${home}/.local/state`, "-type", "f", "-printf", format],
			{
				stderr: "ignore",
			},
		),
	);

	const text = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString);
	const lines = Arr.filter(Str.split(text, "\n"), Str.isNonEmpty);

	return new Map(Arr.map(lines, (line) => [Str.replace(/\t[^\t]*\t[^\t]*$/u, "")(line), line]));
}, Effect.scoped);

/** Runs the scenario under strace, streaming its output, and returns its exit code and its `evidence` folder. */
const traceRun = Effect.fn("traceRun")(function* ({
	scenario,
	prefix,
}: {
	readonly scenario: string;
	readonly prefix: string;
}) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const strace = ["-ff", "-y", "-qq", "--seccomp-bpf", "-e", `trace=${Arr.join(traced, ",")}`, "-o", prefix];

	const handle = yield* spawner.spawn(
		ChildProcess.make("strace", [...strace, "bun", scenario], { stdin: "ignore", stderr: "inherit" }),
	);

	const output = yield* handle.stdout.pipe(
		Stream.decodeText,
		Stream.tap((text) => Effect.sync(() => process.stdout.write(text))),
		Stream.mkString,
	);

	const code = yield* handle.exitCode;
	const evidence = Option.fromNullishOr(/^evidence (?<folder>.+)$/mu.exec(output)?.groups?.["folder"]);

	return { code, evidence };
}, Effect.scoped);

const RunRecord = Schema.fromJsonString(Schema.Struct({ coreSession: Schema.String }));

/** The run's core session, and the realpath of every session file under the run's `sessions/`. */
const runFacts = Effect.fn("runFacts")(function* (evidence: string) {
	const fs = yield* FileSystem.FileSystem;
	const record = yield* Effect.flatMap(fs.readFileString(`${evidence}/run.json`), Schema.decodeEffect(RunRecord));
	const names = yield* fs.readDirectory(`${evidence}/sessions`, { recursive: true });
	const files = Arr.map(Arr.filter(names, Str.endsWith(".jsonl")), (name) => `${evidence}/sessions/${name}`);
	const sessionFiles = yield* Effect.forEach(files, (file) => fs.realPath(file));

	return { coreSession: record.coreSession, sessionFiles };
});

const traceTexts = Effect.fn("traceTexts")(function* (folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const names = yield* fs.readDirectory(folder);

	return yield* Effect.forEach(names, (name) => fs.readFileString(`${folder}/${name}`));
});

const describe = (each: Traced) => (each.kind === "connect" ? `connect ${each.socket}` : `${each.call} ${each.path}`);

/** Pure. Each new, changed or deleted file, and whether a traced write of the run names it. */
const changesOf = (input: {
	readonly before: ReadonlyMap<string, string>;
	readonly after: ReadonlyMap<string, string>;
	readonly written: ReadonlySet<string>;
}) => {
	const by = (path: string) => (input.written.has(path) ? "run" : "another process");
	const isChanged = (path: string) => input.before.has(path) && input.before.get(path) !== input.after.get(path);

	return [
		...Arr.map(
			Arr.filter([...input.after.keys()], (path) => !input.before.has(path)),
			(path) => `  new ${path}  by ${by(path)}`,
		),
		...Arr.map(Arr.filter([...input.after.keys()], isChanged), (path) => `  changed ${path}  by ${by(path)}`),
		...Arr.map(
			Arr.filter([...input.before.keys()], (path) => !input.after.has(path)),
			(path) => `  deleted ${path}  by ${by(path)}`,
		),
	];
};

const section = (title: string, lines: ReadonlyArray<string>) => [`${title}: ${String(lines.length)}`, ...lines];

type Outcome = "yes" | "no" | "cannot vouch";

const outcomeOf = (verdict: Verdict): Outcome => {
	if (Arr.isReadonlyArrayNonEmpty(verdict.violations)) {
		return "no";
	}

	return Arr.isReadonlyArrayNonEmpty(verdict.unresolved) || Arr.isReadonlyArrayNonEmpty(verdict.missed)
		? "cannot vouch"
		: "yes";
};

const listed = (calls: ReadonlyArray<Traced>) => Arr.map(calls, (each) => `  ${describe(each)}`);

/** Pure. The report's lines. */
const reportOf = (input: {
	readonly scenarioExit: number;
	readonly traces: number;
	readonly calls: number;
	readonly verdict: Verdict;
	readonly sessionFiles: number;
	readonly changes: ReadonlyArray<string>;
}) => {
	const { verdict } = input;
	const seen = input.sessionFiles - verdict.missed.length;

	return [
		`scenario exit ${String(input.scenarioExit)}`,
		`traced ${String(input.traces)} processes, ${String(input.calls)} writes and connects`,
		...section("changed files", input.changes),
		...section("sanctioned", listed(verdict.sanctioned)),
		...section("violations", listed(verdict.violations)),
		...section("unresolved", listed(verdict.unresolved)),
		`coverage ${String(seen)}/${String(input.sessionFiles)} run session files seen written`,
		...Arr.map(verdict.missed, (file) => `  missed ${file}`),
		`untouched ${outcomeOf(verdict)}`,
	];
};

/** Traces the run between two listings of the human's folders. */
const observed = Effect.fn("observed")(function* (scenario: string) {
	const fs = yield* FileSystem.FileSystem;
	const home = yield* Config.String("HOME");
	const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "pi-untouched-" });
	const before = yield* listing(home);

	yield* fs.makeDirectory(`${tmp}/trace`);

	const run = yield* traceRun({ scenario, prefix: `${tmp}/trace/trace` });
	const after = yield* listing(home);
	const texts = yield* traceTexts(`${tmp}/trace`);

	yield* Console.log(`listed ${String(before.size)} files before the run, ${String(after.size)} after`);

	return { home, before, after, run, texts };
}, Effect.scoped);

/** `path` with the links in its longest existing part resolved, so a write named through a link lands where it went. */
const onDisk = (path: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const real = yield* Effect.option(fs.realPath(path));
		const cut = Option.filter(Str.lastIndexOf("/")(path), (at) => at > 0);

		if (Option.isSome(real) || Option.isNone(cut)) {
			return Option.getOrElse(real, () => path);
		}

		return `${yield* onDisk(Str.slice(0, cut.value)(path))}${Str.slice(cut.value)(path)}`;
	});

/** Judges what `observed` saw, for the run whose evidence folder is `evidence`. */
const judged = Effect.fn("judged")(function* (seen: Effect.Success<ReturnType<typeof observed>>, evidence: string) {
	const facts = yield* runFacts(evidence);

	const roots = yield* Effect.forEach([`${seen.home}/.pi`, `${seen.home}/.local/state`], (root) =>
		Effect.map(onDisk(root), (real) => ({ root, real })),
	);

	/** A path under a protected folder's real place, named by the folder's path in `home`, which `judge` checks. */
	const named = (path: string) =>
		Option.match(
			Arr.findFirst(roots, ({ real }) => Str.startsWith(`${real}/`)(`${path}/`)),
			{ onNone: () => path, onSome: ({ root, real }) => `${root}${Str.slice(real.length)(path)}` },
		);

	const calls = yield* Effect.forEach(
		writesIn(seen.texts),
		(each): Effect.Effect<Traced, never, FileSystem.FileSystem> =>
			each.kind === "write"
				? Effect.map(onDisk(each.path), (path) => ({ ...each, path: named(path) }))
				: Effect.succeed(each),
	);

	const verdict = judge({
		traced: calls,
		home: seen.home,
		coreSession: facts.coreSession,
		runSessionFiles: facts.sessionFiles,
	});

	const written = new Set(Arr.flatMap(calls, (each) => (each.kind === "connect" ? [] : [each.path])));

	const lines = reportOf({
		scenarioExit: seen.run.code,
		traces: seen.texts.length,
		calls: calls.length,
		verdict,
		sessionFiles: facts.sessionFiles.length,
		changes: changesOf({ before: seen.before, after: seen.after, written }),
	});

	return { text: Arr.join(lines, "\n"), outcome: outcomeOf(verdict) };
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

	const { text, outcome } = yield* judged(seen, seen.run.evidence.value);

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

NodeRuntime.runMain(Effect.provide(program, NodeServices.layer), { teardown: exitCode });
