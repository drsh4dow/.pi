/**
 * The runtime driver's whole interface. A `<fact>.scenario.ts` file calls `scenario` once, and `bun <file>` runs it
 * against the real pi on PATH, this worktree's `agent/`, and scratch HOME, session, state and terminal core. README.md
 * is the author's guide. The lint lets only `*.scenario.ts` files import this module, and lets nothing import theirs.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import type * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Exited, startCore, sweep } from "./core.ts";
import { ScenarioFailed, SetupFailed } from "./failed.ts";
import { type Root, type RootProcess, startRoot } from "./root.ts";
import { readSessions, type Sessions } from "./sessions.ts";
import { type Layout, layoutOf, openWorld, type Setup } from "./world.ts";

export type { ScenarioFailed } from "./failed.ts";

export type { Root } from "./root.ts";

export type { Loaded, Session, Sessions } from "./sessions.ts";

export type { Exited } from "./core.ts";

/**
 * One scenario: what it changes about the run's world before the root starts, and `play`, what it does in the run.
 * Every pi in the run, delegates included, sees the setup.
 */
export interface Scenario<Failure> extends Setup {
	/** The root's `provider/id`. Required, so every scenario states what it spends. */
	readonly model: string;
	/** Top-level keys that replace the same keys in the run's copy of the human's `settings.json`. */
	readonly settings?: Schema.JsonObject;
	/**
	 * Provider entries by name, shaped like `models.json`'s `providers` values (`modelOverrides` included). Each replaces
	 * the human's entry of that name in the run's copy of their `models.json`, or starts the file when they have none.
	 * pi validates the result when the root starts, so a bad entry is exit 2, not a scenario failure.
	 */
	readonly models?: Readonly<Record<string, Schema.JsonObject>>;
	/** Runs once the root answers. Any failure fails the scenario with exit 1 and prints the failure's message. */
	readonly play: (run: Run) => Effect.Effect<void, Failure, Allowed>;
}

/**
 * One isolated pi world: a root pi in RPC mode, a private terminal core its delegates run in, and scratch folders.
 * It exists only while `play` runs. The driver stops every process in it afterwards, whatever the outcome.
 */
export interface Run {
	/** The pi every agent in the run executes: the `pi` on the human's PATH, resolved through links. */
	readonly pi: { readonly version: string; readonly path: string };
	/** This worktree's `agent/` folder. Every pi in the run loads extensions, prompts and `bin/` from it. */
	readonly agentDir: string;
	/** `HOME` for every process in the run. An agent's `~/.local/state/pi-agent/...` lands under it, never in the human's. */
	readonly home: string;
	/** The root pi, started and answering before `play` runs. */
	readonly root: Root;
	/**
	 * Reads the root's and every delegate's session file once a second until `find` returns `Some`, prints
	 * `<elapsed>  found <what>`, and returns the value.
	 * Fails with `timed out after <within> waiting for <what>`, and at once if the root pi exits. Every session read goes
	 * through here, because pi writes the files as it goes.
	 */
	readonly waitFor: <Found>(
		what: string,
		within: Duration.Input,
		find: (sessions: Sessions) => Option.Option<Found>,
	) => Effect.Effect<Found, ScenarioFailed>;
	/**
	 * Runs a command in the run's environment and the root's project folder: `hc` reaches the run's terminal core, `pi`
	 * is `run.pi` with the probe, and HOME, the agent folder and the state folders are the run's. Fails only when the
	 * command cannot start or runs past a minute. The scenario reads `code`.
	 */
	readonly exec: (argv: readonly [string, ...Array<string>]) => Effect.Effect<Exited, ScenarioFailed>;
	/** Prints a line to stdout and `report.txt`. A string prints as is, anything else as one line of JSON. */
	readonly say: (value: Schema.Json) => Effect.Effect<void>;
	/** Fails the scenario with `claim` unless `condition` holds. State the claim as the expected fact plus what you saw. */
	readonly check: (condition: boolean, claim: string) => Effect.Effect<void, ScenarioFailed>;
}

/** What `play` may use besides `run`. No process spawner: `run.exec` is the only way to start a command. */
type Allowed = FileSystem.FileSystem | Path.Path;

const check = (condition: boolean, claim: string): Effect.Effect<void, ScenarioFailed> =>
	condition ? Effect.void : Effect.fail(ScenarioFailed.make({ message: claim }));

/** `features/owned-work/leaf-wake.scenario.ts` is `leaf-wake`. */
const nameOf = (entry: string) => Str.replace(/^(?:.*\/)?(?<name>[^/]+?)(?:\.scenario)?\.ts$/u, "$<name>")(entry);

/** `20260514-101010` from an ISO time. */
const stampOf = Str.replace(
	/^(?<year>\d{4})-(?<month>\d\d)-(?<day>\d\d)T(?<hour>\d\d):(?<minute>\d\d):(?<second>\d\d).*$/u,
	"$<year>$<month>$<day>-$<hour>$<minute>$<second>",
);

const messageOf = (cause: Cause.Cause<unknown>) => {
	const error = Cause.squash(cause);

	return Predicate.isError(error) ? error.message : String(error);
};

const verdictOf = <Value, Failure>(name: string, exit: Exit.Exit<Value, Failure>, seconds: number) => {
	if (Exit.isSuccess(exit)) {
		return `pass ${name} in ${String(seconds)} s`;
	}

	if (Cause.hasInterruptsOnly(exit.cause)) {
		return `interrupted ${name}`;
	}

	return Option.exists(Cause.findErrorOption(exit.cause), Schema.is(SetupFailed))
		? `broken ${name}: ${messageOf(exit.cause)}`
		: `fail ${name}: ${messageOf(exit.cause)}`;
};

const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** Prints to stdout and appends to `report.txt`, and counts seconds from the run's start. */
const reporter = Effect.fn("reporter")(function* (report: string) {
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

type Reporter = Effect.Success<ReturnType<typeof reporter>>;

/** `waitFor` over the run's session files, raced against the root's exit. */
const waiting =
	(sessions: Effect.Effect<Sessions, ScenarioFailed>, root: RootProcess, report: Reporter) =>
	<Found>(what: string, within: Duration.Input, find: (sessions: Sessions) => Option.Option<Found>) => {
		const poll = (): Effect.Effect<Found, ScenarioFailed> =>
			Effect.flatMap(sessions, (all) =>
				Option.match(find(all), {
					onSome: Effect.succeed,
					onNone: () => Effect.andThen(Effect.sleep("1 second"), poll()),
				}),
			);

		const timedOut = ScenarioFailed.make({
			message: `timed out after ${String(Duration.toSeconds(within))} s waiting for ${what}`,
		});

		return poll().pipe(
			Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(timedOut) }),
			(polling) => Effect.raceFirst(polling, root.exited),
			Effect.tap(() => report.progress(`found ${what}`)),
		);
	};

/** Builds the world, plays the scenario in it, and tears it all down when the scope closes. */
const playIn = <Failure>({
	spec,
	layout,
	report,
}: {
	readonly spec: Scenario<Failure>;
	readonly layout: Layout;
	readonly report: Reporter;
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const world = yield* openWorld({ layout, setup: spec });

		yield* startCore({ layout, env: world.env });
		yield* report.say(`pi ${world.pi.version} ${world.pi.path}`);
		yield* report.say(`agent ${world.agentDir}`);

		const root = yield* startRoot({ world, model: spec.model, progress: report.progress });
		const sessions = readSessions({ root: root.session, sessionDir: layout.sessions, probeDir: layout.probe });

		const run: Run = {
			pi: world.pi,
			agentDir: world.agentDir,
			home: layout.home,
			root,
			waitFor: waiting(Effect.provideService(sessions, FileSystem.FileSystem, fs), root, report),
			exec: world.exec,
			say: report.say,
			check,
		};

		yield* Effect.raceFirst(spec.play(run), root.exited);
	}).pipe(Effect.scoped);

/** A fresh run's layout under `$TMPDIR`, after sweeping the runs there that died without cleaning up. */
const freshLayout = Effect.fn("freshLayout")(function* (name: string) {
	const tmp = yield* Config.String("TMPDIR").pipe(Config.withDefault("/tmp"));
	const now = yield* DateTime.now;
	const tag = yield* Random.nextIntBetween(0, 2 ** 24);

	yield* sweep(tmp);

	return layoutOf({
		tmp,
		name,
		stamp: now.pipe(DateTime.formatIso, stampOf),
		pid: process.pid,
		tag: Str.padStart(6, "0")(tag.toString(16)),
	});
});

/** Plays the scenario, and prints the verdict and `evidence <folder>` last, after every cleanup. */
const played = <Failure>({ name, spec }: { readonly name: string; readonly spec: Scenario<Failure> }) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const layout = yield* freshLayout(name).pipe(
			Effect.tap((fresh) => fs.makeDirectory(fresh.folder, { recursive: true, mode: 0o700 })),
			Effect.catchTag("PlatformError", (error) => Effect.fail(SetupFailed.make({ message: error.message }))),
		);

		const report = yield* reporter(layout.report);

		yield* report.say(`scenario ${name}`);
		yield* report.say(`run ${layout.folder}`);
		yield* playIn({ spec, layout, report }).pipe(
			Effect.onExit((exit) =>
				Effect.flatMap(report.elapsed, (seconds) =>
					Effect.andThen(report.say(verdictOf(name, exit, seconds)), report.say(`evidence ${layout.folder}`)),
				),
			),
		);
	});

/** The process boundary, so the one place that reads a failure's class: interrupt 130, `SetupFailed` 2, else 1. */
const codeOf = <Value, Failure>(exit: Exit.Exit<Value, Failure>): number => {
	if (Exit.isSuccess(exit)) {
		return 0;
	}

	if (Cause.hasInterruptsOnly(exit.cause)) {
		return 130;
	}

	return Option.exists(Cause.findErrorOption(exit.cause), Schema.is(SetupFailed)) ? 2 : 1;
};

const exitCode: Runtime.Teardown = (exit, onExit) => {
	onExit(codeOf(exit));
};

/**
 * Runs this file's scenario and exits: 0 passed, 1 failed (any error from `play`, a timeout, the root dying), 2 the run
 * could not be built, 130 interrupted. The scenario's name is the entry file's name without `.scenario.ts`.
 */
export const scenario = <Failure>(spec: Scenario<Failure>): void => {
	const program = played({ name: nameOf(process.argv[1] ?? "scenario"), spec });

	NodeRuntime.runMain(Effect.provide(program, NodeServices.layer), {
		disableErrorReporting: true,
		teardown: exitCode,
	});
};
