/**
 * Side commands in the run's environment, and the run's private terminal core, where owned-work starts delegates. The
 * core gets its own `XDG_RUNTIME_DIR`: with no systemd socket in it, herdr-core runs terminals as its own descendants
 * instead of systemd services, so they stay in the run's service. Every spawn here is `detached: false`: Effect then
 * never signals a child that already exited, whose pid another process may hold by then.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
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
			detached: false,
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
 * Starts the run's core and waits for its socket. Closing the scope asks the core to stop, which ends its terminals
 * before the tripwire reads, and then removes the core's folder.
 */
export const startCore = Effect.fn("startCore")(
	function* ({ layout, env }: { readonly layout: Layout; readonly env: Env }) {
		const fs = yield* FileSystem.FileSystem;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const place = { env: { ...env, XDG_RUNTIME_DIR: layout.runtime }, cwd: layout.folder };

		yield* fs.makeDirectory(layout.runtime, { recursive: true, mode: 0o700 });
		yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(layout.runtime, { recursive: true })));

		yield* spawner.spawn(
			ChildProcess.make("sh", ["-c", 'exec herdr-core serve >>"$1" 2>&1', "core", layout.coreLog], {
				...place,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				detached: false,
				forceKillAfter: "10 seconds",
			}),
		);

		yield* Effect.addFinalizer(() =>
			ran({ argv: ["hc", "server", "stop"], ...place }).pipe(
				Effect.timeout("10 seconds"),
				Effect.ignore,
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			),
		);

		// Polls the socket file, not `hc ls`: hc starts a core of its own as a systemd service when it finds none.
		yield* fs.exists(layout.socket).pipe(
			Effect.repeat({ until: (exists) => exists, schedule: Schedule.spaced("100 millis") }),
			Effect.timeoutOrElse({
				duration: "10 seconds",
				orElse: () =>
					Effect.fail(SetupFailed.make({ message: `the terminal core did not start, see ${layout.coreLog}` })),
			}),
		);
	},
	Effect.catchTag("PlatformError", (error) => Effect.fail(SetupFailed.make({ message: error.message }))),
);
