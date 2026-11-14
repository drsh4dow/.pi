/**
 * Every process of a run lives in one transient systemd user service. `bun <file>` starts the driver again as that
 * service's main process, its stdin a pipe from the process the human started. However that process ends, the pipe
 * closes and the driver in the service ends the run as if interrupted. Once the driver in the service exits, however
 * it exits, systemd kills every process left in the service's cgroup. No code of the driver signals a process.
 *
 * A pid namespace would tie the run to the driver more tightly, but `systemd-run --user`, which owned-work starts
 * every delegate with, refuses the user manager from inside one.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import type * as Runtime from "effect/Runtime";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

const marker = "PI_DRIVER_SERVICE";

/** Whether this process is the driver inside the run's service. */
export const inService = (): boolean => Bun.env[marker] === "1";

/** Interrupts once stdin ends: the process the human started closed it, or died. */
export const stdinEnded = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio;

	yield* Stream.runDrain(stdio.stdin);
}).pipe(Effect.ignore, Effect.andThen(Effect.interrupt));

/** Pure. The `systemd-run` command that runs `argv` as the run's service, in the caller's folder and environment. */
const serviceArgv = (command: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly argv: ReadonlyArray<string>;
}) => [
	"systemd-run",
	"--user",
	"--pipe",
	"--quiet",
	"--collect",
	"--same-dir",
	"--property=KillSignal=SIGKILL",
	...Arr.map(
		Arr.filter(Rec.keys(command.env), (key) => /^[A-Za-z_]\w*$/u.test(key)),
		(key) => `--setenv=${key}`,
	),
	`--setenv=${marker}=1`,
	"--",
	...command.argv,
];

/** Why `argv` did not run to a clean exit, if it did not. */
const failureOf = (argv: Array<string>) =>
	Effect.try({ try: () => Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" }), catch: String }).pipe(
		Effect.flatMap((probe) =>
			Effect.all({ code: Effect.promise(() => probe.exited), stderr: Effect.promise(() => probe.stderr.text()) }),
		),
		Effect.filterOrFail(
			({ code }) => code === 0,
			({ stderr }) => Str.trim(stderr),
		),
		Effect.flip,
		Effect.option,
	);

/** The process exit code: the service's, 130 when interrupted, 1 on a defect. */
const exitCode: Runtime.Teardown = (exit, onExit) => {
	if (Exit.isSuccess(exit)) {
		onExit(Predicate.isNumber(exit.value) ? exit.value : 1);
	} else {
		onExit(Cause.hasInterruptsOnly(exit.cause) ? 130 : 1);
	}
};

/**
 * Runs `argv` as the run's service and exits with its code, or 2 when systemd cannot start one. Ctrl-C and SIGTERM end
 * the service's stdin and wait for it to exit, then exit 130. The `systemd-run` client runs in a session of its own, so
 * Ctrl-C reaches only this process, and nothing here signals it: Effect's spawner would signal its group after it
 * exited.
 */
export const runAsService = ({ name, argv }: { readonly name: string; readonly argv: ReadonlyArray<string> }) => {
	const command = serviceArgv({ env: Bun.env, argv });

	const service = Effect.acquireRelease(
		Effect.sync(() => Bun.spawn(command, { stdin: "pipe", stdout: "inherit", stderr: "inherit", detached: true })),
		(started) =>
			Effect.tryPromise({ try: () => Promise.resolve(started.stdin.end()), catch: String }).pipe(
				Effect.ignore,
				Effect.andThen(Effect.promise(() => started.exited)),
			),
	);

	const program = Effect.gen(function* () {
		const failure = yield* failureOf([...Arr.takeWhile(command, (arg) => arg !== "--"), "--", "true"]);

		if (Option.isSome(failure)) {
			yield* Console.log(`broken ${name}: the driver runs a scenario as a systemd user service: ${failure.value}`);

			return 2;
		}

		const started = yield* service;

		return yield* Effect.promise(() => started.exited);
	}).pipe(Effect.scoped);

	NodeRuntime.runMain(program, { disableErrorReporting: true, teardown: exitCode });
};
