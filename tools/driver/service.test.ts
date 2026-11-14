import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);

		return true;
	} catch {
		return false;
	}
};

/** A run that prints the pids of a child in a session of its own and of an orphan, then exits 7 once its stdin ends. */
const run = `["sh", "-c", "setsid sleep 600 & echo $!; sh -c 'sleep 600 & echo $!'; cat >/dev/null; exit 7"]`;

const driverOf = () =>
	Bun.spawn(
		[
			process.execPath,
			"-e",
			`import { runAsService } from "${import.meta.dirname}/service.ts"; runAsService({ name: "t", argv: ${run} });`,
		],
		{ stdout: "pipe" },
	);

const linesOf = (driver: ReturnType<typeof driverOf>) =>
	Stream.fromReadableStream({ evaluate: () => driver.stdout, onError: String }).pipe(
		Stream.decodeText,
		Stream.splitLines,
	);

/** The run's two pids, once it printed them. */
const pidsOf = (driver: ReturnType<typeof driverOf>) =>
	linesOf(driver).pipe(Stream.take(2), Stream.map(Number), Stream.runCollect);

test("a driver killed outright takes every process of its run with it, and only those", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const outsider = Bun.spawn(["sleep", "600"]);
			const driver = driverOf();
			const pids = yield* pidsOf(driver);

			driver.kill("SIGKILL");
			yield* Effect.sleep("2 seconds");

			expect([Arr.map(pids, isAlive), isAlive(outsider.pid)]).toEqual([[false, false], true]);
			outsider.kill();
		}),
	));

test("Ctrl-C ends the run through its stdin and waits for it", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const driver = driverOf();
			const pids = yield* pidsOf(driver);

			driver.kill("SIGINT");

			const code = yield* Effect.promise(() => driver.exited);

			yield* Effect.sleep("1 second");

			expect([code, Arr.map(pids, isAlive)]).toEqual([130, [false, false]]);
		}),
	));

test("a scenario where systemd-run cannot start a service exits 2 and says so", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const scenario = Bun.spawn([process.execPath, `${import.meta.dirname}/false-fact.scenario.ts`], {
				stdout: "pipe",
				env: { ...Bun.env, PATH: "/nonexistent" },
			});

			const output = yield* Effect.promise(() => scenario.stdout.text());
			const code = yield* Effect.promise(() => scenario.exited);

			expect(code).toBe(2);
			expect(output).toContain("broken false-fact: the driver runs a scenario as a systemd user service");
		}),
	));
