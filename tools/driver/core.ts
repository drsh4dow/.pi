/**
 * The run's private terminal core, where owned-work starts delegates, and the sweep that stops the core of a run killed
 * outright. The core gets its own `XDG_RUNTIME_DIR`: with no systemd socket in it, herdr-core runs terminals as its own
 * descendants instead of systemd services, so they end with it and `strace -f` of the run sees them.
 */
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ScenarioFailed, SetupFailed } from "./failed.ts";
import type { Layout } from "./world.ts";

export type Argv = readonly [string, ...Array<string>];

type Env = Readonly<Record<string, string>>;

/** A command `exec` ran to its end. `output` is stdout and stderr interleaved, as the command printed them. */
export interface Exited {
	readonly code: number;
	readonly output: string;
}

/** Runs `argv` to its end. */
export const ran = Effect.fn("ran")(function* (command: {
	readonly argv: Argv;
	readonly env: Env;
	readonly cwd: string;
}) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const [program, ...args] = command.argv;

	const handle = yield* spawner.spawn(
		ChildProcess.make(program, args, {
			cwd: command.cwd,
			env: command.env,
			stdin: "ignore",
			forceKillAfter: "2 seconds",
		}),
	);

	return yield* Effect.all(
		{ code: handle.exitCode, output: handle.all.pipe(Stream.decodeText, Stream.mkString) },
		{ concurrency: 2 },
	);
}, Effect.scoped);

/** `run.exec`: `ran` in the run's environment, failing the scenario only when the command cannot start or hangs. */
export const execIn = Effect.fn("execIn")(function* (place: { readonly env: Env; readonly cwd: string }) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	return (argv: Argv) =>
		ran({ argv, ...place }).pipe(
			Effect.timeoutOrElse({
				duration: "1 minute",
				orElse: () => Effect.fail(ScenarioFailed.make({ message: `${Arr.join(argv, " ")} ran past a minute` })),
			}),
			Effect.catchTag("PlatformError", (error) =>
				Effect.fail(ScenarioFailed.make({ message: `${Arr.join(argv, " ")} did not start: ${error.message}` })),
			),
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
		);
});

/**
 * `run.json`: what a sweep needs to clean up after a run, written before anything needs cleaning. It holds no paths:
 * the sweep derives them, so a forged record cannot point a removal elsewhere.
 */
const RunRecord = Schema.Struct({
	pid: Schema.Finite,
	coreSession: Schema.String.check(Schema.isPattern(/^pi-driver-\d+-[0-9a-f]{6}$/u)),
});

const recordJson = Schema.fromJsonString(RunRecord);

export const writeRecord = Effect.fn("writeRecord")(function* (layout: Layout) {
	const fs = yield* FileSystem.FileSystem;

	const record = yield* Schema.encodeEffect(recordJson)({ pid: process.pid, coreSession: layout.coreSession });

	yield* fs.writeFileString(layout.record, record);
});

const decodeRecord = Schema.decodeEffect(recordJson);

const stopCore = (run: { readonly folder: string; readonly coreSession: string; readonly socket: string }) =>
	Effect.flatMap(Config.String("PATH"), (path) =>
		ran({
			argv: ["hc", "server", "stop"],
			env: { PATH: path, HOME: `${run.folder}/home`, HC_SESSION: run.coreSession, HC_SOCKET: run.socket },
			cwd: run.folder,
		}),
	).pipe(Effect.timeout("10 seconds"), Effect.ignore);

/** Starts the run's core and waits for its socket. The scope stops it and removes its runtime folder. */
export const startCore = Effect.fn("startCore")(function* ({
	layout,
	env,
}: {
	readonly layout: Layout;
	readonly env: Readonly<Record<string, string>>;
}) {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	yield* fs.makeDirectory(layout.runtime, { recursive: true, mode: 0o700 });
	yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(layout.runtime, { recursive: true })));

	const core = yield* spawner
		.spawn(
			ChildProcess.make("herdr-core", ["serve"], {
				cwd: layout.folder,
				env: { ...env, XDG_RUNTIME_DIR: layout.runtime },
				stdin: "ignore",
				forceKillAfter: "10 seconds",
			}),
		)
		.pipe(
			Effect.catchTag("PlatformError", (error) =>
				Effect.fail(SetupFailed.make({ message: `herdr-core did not start: ${error.message}` })),
			),
		);

	yield* Effect.forkScoped(Stream.run(core.all, fs.sink(layout.coreLog)));
	yield* Effect.addFinalizer(() => stopCore(layout));

	// Polls the socket file, not `hc ls`: hc starts a core of its own as a systemd service when it finds none.
	yield* fs.exists(layout.socket).pipe(
		Effect.repeat({ until: (exists) => exists, schedule: Schedule.spaced("100 millis") }),
		Effect.timeoutOrElse({
			duration: "10 seconds",
			orElse: () =>
				Effect.fail(SetupFailed.make({ message: `the terminal core did not start, see ${layout.coreLog}` })),
		}),
	);
});

/** Stops the core of one dead run and unlinks its `auth.json`. A run that cleaned up has no link left. */
const swept = Effect.fn("swept")(function* (runs: string, name: string) {
	const fs = yield* FileSystem.FileSystem;
	const folder = `${runs}/${name}`;
	const { pid, coreSession } = yield* Effect.flatMap(fs.readFileString(`${folder}/run.json`), decodeRecord);
	const auth = `${folder}/home/.pi/agent/auth.json`;
	const runtime = `${runs}/${coreSession}`;

	if ((yield* fs.readLink(auth)) === "" || (yield* fs.exists(`/proc/${String(pid)}`))) {
		return;
	}

	yield* stopCore({ folder, coreSession, socket: `${runtime}/herdr-core/${coreSession}.sock` });
	yield* fs.remove(auth);
	yield* fs.remove(runtime, { recursive: true, force: true });
});

/**
 * Cleans up after earlier runs killed outright: their core would keep delegates spending tokens, and their link to the
 * human's `auth.json` would stay. Skips live runs, so it is safe beside other agents' runs, and safe to repeat.
 */
export const sweep = Effect.fn("sweep")(function* (tmp: string) {
	const fs = yield* FileSystem.FileSystem;
	const runs = `${tmp}/pi-driver`;

	yield* fs.makeDirectory(runs, { recursive: true, mode: 0o700 });

	const { uid } = yield* fs.stat(runs);
	const foreign = !Option.contains(uid, process.getuid?.() ?? -1);

	yield* Effect.when(
		Effect.fail(SetupFailed.make({ message: `${runs} belongs to another user` })),
		Effect.succeed(foreign),
	);

	const names = yield* fs.readDirectory(runs);

	yield* Effect.forEach(names, (name) => Effect.ignore(swept(runs, name)));
});
