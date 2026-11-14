/**
 * Side commands in the run's environment, and the run's private terminal core, where owned-work starts delegates. The
 * core gets its own `XDG_RUNTIME_DIR`: with no systemd socket in it, herdr-core runs terminals as its own descendants
 * instead of systemd services, so they end with it.
 */
import * as Arr from "effect/Array";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
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
 * Stops the core once its stdin ends, whether the scope closed it or the kernel did because the driver died outright.
 * When `hc` cannot stop it, the guardian signals the core itself: an unreaped child keeps its pid, so the signal
 * reaches no other process. It unlinks the human's credentials first, and removes the core's folder only after the
 * core exited. Every path it removes comes from its own environment, set when the driver started it.
 */
const guardian = `herdr-core serve >>"$1" 2>&1 &
core=$!
cat >/dev/null
rm -f "$HOME/.pi/agent/auth.json"
hc server stop >>"$1" 2>&1 || kill "$core"
wait "$core"
rm -rf "$XDG_RUNTIME_DIR"`;

/** Starts the run's core under `guardian` and waits for its socket. Closing the scope runs the guardian's cleanup. */
export const startCore = Effect.fn("startCore")(
	function* ({ layout, env }: { readonly layout: Layout; readonly env: Env }) {
		const fs = yield* FileSystem.FileSystem;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();

		yield* fs.makeDirectory(layout.runtime, { recursive: true, mode: 0o700 });

		const guard = yield* spawner.spawn(
			ChildProcess.make("sh", ["-c", guardian, "guardian", layout.coreLog], {
				cwd: layout.folder,
				env: { ...env, XDG_RUNTIME_DIR: layout.runtime },
				stdin: Stream.fromQueue(input),
				stdout: "ignore",
				stderr: "ignore",
				forceKillAfter: "10 seconds",
			}),
		);

		yield* Effect.addFinalizer(() =>
			Queue.end(input).pipe(Effect.andThen(guard.exitCode), Effect.timeout("30 seconds"), Effect.ignore),
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
