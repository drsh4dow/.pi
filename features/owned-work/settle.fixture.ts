import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";

// Effect resumes fibers directly from file callbacks without scheduling a task, so file operations need a separate count.
export interface InFlight {
	tasks: number;
	files: number;
}

export interface WorldClock {
	backMs: number;
	sleeping: number;
	readonly paused: TestClock.TestClock;
}

export interface Pacing {
	readonly clock: WorldClock;
	readonly inFlight: InFlight;
}

const sleepsOnPause =
	(clock: WorldClock) =>
	(real: Clock.Clock): Clock.Clock => {
		const { paused } = clock;
		const millis = () => real.currentTimeMillisUnsafe() + paused.currentTimeMillisUnsafe() - clock.backMs;

		const nanos = () =>
			real.currentTimeNanosUnsafe() + paused.currentTimeNanosUnsafe() - BigInt(clock.backMs) * 1_000_000n;

		const monotonic = () => real.monotonicTimeNanosUnsafe() + paused.monotonicTimeNanosUnsafe();

		const sleep = (duration: Duration.Duration) =>
			Effect.suspend(() => {
				clock.sleeping += 1;

				return Effect.ensuring(
					paused.sleep(duration),
					Effect.sync(() => {
						clock.sleeping -= 1;
					}),
				);
			});

		return {
			currentTimeMillisUnsafe: millis,
			currentTimeMillis: Effect.sync(millis),
			currentTimeNanosUnsafe: nanos,
			currentTimeNanos: Effect.sync(nanos),
			monotonicTimeNanosUnsafe: monotonic,
			monotonicTimeNanos: Effect.sync(monotonic),
			sleep,
		};
	};

const countingScheduler =
	(inFlight: InFlight) =>
	(parent: Scheduler.Scheduler): Scheduler.Scheduler => ({
		executionMode: parent.executionMode,
		shouldYield: (fiber) => parent.shouldYield(fiber),
		makeDispatcher: () => {
			const dispatcher = parent.makeDispatcher();

			return {
				scheduleTask: (task, priority) => {
					inFlight.tasks += 1;
					dispatcher.scheduleTask(() => {
						inFlight.tasks -= 1;
						task();
					}, priority);
				},
				flush: () => {
					dispatcher.flush();
				},
			};
		},
	});

const counted =
	(inFlight: InFlight) =>
	<Args extends ReadonlyArray<unknown>, Value, Failure, Needs>(
		operation: (...args: Args) => Effect.Effect<Value, Failure, Needs>,
	) =>
	(...args: Args) =>
		Effect.suspend(() => {
			inFlight.files += 1;

			return Effect.ensuring(
				operation(...args),
				Effect.sync(() => {
					inFlight.files -= 1;
				}),
			);
		}).pipe(Effect.uninterruptible);

// Node filesystem I/O can outlive fiber interruption, so keep the count until the operation completes.
export const countingFiles =
	(inFlight: InFlight) =>
	(fs: FileSystem.FileSystem): FileSystem.FileSystem => {
		const count = counted(inFlight);

		return FileSystem.make({
			access: count(fs.access),
			copy: count(fs.copy),
			copyFile: count(fs.copyFile),
			chmod: count(fs.chmod),
			chown: count(fs.chown),
			link: count(fs.link),
			lstat: count(fs.lstat),
			makeDirectory: count(fs.makeDirectory),
			makeTempDirectory: count(fs.makeTempDirectory),
			makeTempDirectoryScoped: count(fs.makeTempDirectoryScoped),
			makeTempFile: count(fs.makeTempFile),
			makeTempFileScoped: count(fs.makeTempFileScoped),
			open: count(fs.open),
			readDirectory: count(fs.readDirectory),
			readDirectoryEntries: count(fs.readDirectoryEntries),
			readFile: count(fs.readFile),
			readLink: count(fs.readLink),
			realPath: count(fs.realPath),
			remove: count(fs.remove),
			rename: count(fs.rename),
			stat: count(fs.stat),
			symlink: count(fs.symlink),
			truncate: count(fs.truncate),
			utimes: count(fs.utimes),
			writeFile: count(fs.writeFile),
			watch: fs.watch,
		});
	};

export const drained = (inFlight: InFlight): Effect.Effect<void> =>
	Effect.callback((resume) => {
		const poll = () => {
			if (inFlight.tasks === 0 && inFlight.files === 0) {
				resume(Effect.void);
			} else {
				next.timer = setImmediate(poll);
			}
		};

		const next = { timer: setImmediate(poll) };

		return Effect.sync(() => {
			clearImmediate(next.timer);
		});
	});

export const settling = <Value, Failure>(
	play: (pacing: Pacing) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value, Failure> =>
	Effect.scoped(
		Effect.gen(function* () {
			const clock = { backMs: 0, sleeping: 0, paused: yield* TestClock.make() };
			const inFlight = { tasks: 0, files: 0 };
			const real = yield* Clock.clockWith(Effect.succeed);

			return yield* play({ clock, inFlight }).pipe(
				Effect.updateService(Scheduler.Scheduler, countingScheduler(inFlight)),
				Effect.provideService(Clock.Clock, sleepsOnPause(clock)(real)),
			);
		}),
	);
