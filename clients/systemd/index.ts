import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import type { RunSpec } from "../hc/index.ts";

export class Slices extends Context.Service<
	Slices,
	{
		readonly wrap: (spec: RunSpec) => RunSpec;
		readonly stop: (ref: string) => Effect.Effect<void>;
		/** Stops every job the root started. A reload skips it, so the work outlives the extension and the next load takes it over. */
		readonly stopAll: Effect.Effect<void>;
	}
>()("pi-harness/clients/systemd/Slices") {}

class NoUserManager extends Schema.TaggedError<NoUserManager, { readonly brand: unique symbol }>()("NoUserManager", {
	message: Schema.String,
}) {}

const noUserManager = (output: string) =>
	NoUserManager.make({
		message: `owned-work runs each delegate in a systemd user scope, and systemd-run --user failed: ${output}`,
	});

export interface SliceOptions {
	readonly slice: string;
	readonly rootPid: Option.Option<number>;
}

const notLoaded = 5;

/** How long a stopped job has after SIGTERM before systemd sends SIGKILL to what is left of it, as `pi.exec` waits. */
const stopGrace = "5s";

const unitOf = (slice: string, ref: string) => `${slice}-${Str.replaceAll("-", "")(ref)}`;

const finished = (handle: ChildProcessSpawner.ChildProcessHandle) =>
	Effect.all(
		{ code: handle.exitCode, output: handle.all.pipe(Stream.decodeText, Stream.mkString) },
		{ concurrency: 2 },
	);

const systemd = (
	spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
	program: string,
	args: ReadonlyArray<string>,
	ok: ReadonlyArray<number>,
) =>
	spawner.spawn(ChildProcess.make(program, ["--user", ...args])).pipe(
		Effect.flatMap(finished),
		Effect.scoped,
		Effect.mapError((error) => error.message),
		Effect.filterOrFail(
			({ code }) => ok.includes(code),
			({ output }) => Str.trim(output),
		),
	);

const stopUnit = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], unit: string) =>
	Effect.ignore(systemd(spawner, "systemctl", ["stop", "--no-block", unit], [0, notLoaded]), { log: "Warn" });

/** Stops the root's watcher, whose ExecStopPost stops the root's slice and every job in it. */
export const stopRoot = (slice: string) =>
	Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => stopUnit(spawner, `${slice}.service`));

const isActive = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], unit: string) =>
	Effect.isSuccess(systemd(spawner, "systemctl", ["is-active", "--quiet", unit], [0]));

/**
 * The root's slice outlives a `kill -9` of the root, so a user service outside hc waits on the root's pid and stops
 * the slice once it exits. After a reload the watcher from the first load is still running, and it stays.
 */
const watchRoot = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], slice: string, pid: number) => {
	const service = [
		"--quiet",
		"--collect",
		`--unit=${slice}`,
		`--property=ExecStopPost=systemctl --user stop --no-block ${slice}.slice`,
		"--",
		"tail",
		`--pid=${String(pid)}`,
		"-f",
		"/dev/null",
	];

	const start = Effect.mapError(systemd(spawner, "systemd-run", service, [0]), noUserManager);

	return Effect.flatMap(isActive(spawner, `${slice}.service`), (running) =>
		running ? Effect.void : Effect.asVoid(start),
	);
};

export const slicesLayer = ({
	slice,
	rootPid,
}: SliceOptions): Layer.Layer<Slices, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.effect(
		Slices,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

			yield* Effect.orDie(Effect.forEach(Option.toArray(rootPid), (pid) => watchRoot(spawner, slice, pid)));

			return Slices.of({
				wrap: (spec) => {
					const unit = unitOf(slice, spec.ref);

					return {
						...spec,
						argv: [
							"systemd-run",
							"--user",
							"--scope",
							"--quiet",
							"--collect",
							`--property=TimeoutStopSec=${stopGrace}`,
							`--slice=${unit}.slice`,
							`--unit=${unit}`,
							"--",
							...spec.argv,
						],
						env: { ...spec.env, PI_OWNED_WORK_SLICE: unit },
					};
				},
				stop: (ref) => stopUnit(spawner, `${unitOf(slice, ref)}.slice`),
				stopAll: Option.isSome(rootPid) ? stopUnit(spawner, `${slice}.service`) : Effect.void,
			});
		}),
	);
