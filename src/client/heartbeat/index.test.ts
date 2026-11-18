import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import type * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";

import { eventually } from "#src/primitives/eventually.ts";
import { isHeartbeat, teeWithHeartbeats } from "./index.ts";

type Step = { readonly print: string } | { readonly wait: Duration.Input };

type Part = string | Uint8Array;

const world = Layer.merge(NodeServices.layer, TestClock.layer());

const encoder = new TextEncoder();

const fed = (input: Queue.Queue<Uint8Array, Cause.Done>, parts: Array<Part>) => (step: Step) => {
	if ("wait" in step) {
		return TestClock.adjust(step.wait);
	}

	const before = parts.length;
	const passedOn = Effect.sync(() => parts.length > before);

	return Effect.andThen(
		Queue.offer(input, encoder.encode(step.print)),
		TestClock.withLive(eventually(passedOn, "2 seconds")),
	);
};

const stdioOf = (input: Queue.Queue<Uint8Array, Cause.Done>, parts: Array<Part>) =>
	Stdio.make({
		args: Effect.succeed([]),
		stdin: Stream.fromQueue(input),
		stdout: () =>
			Sink.forEach((part: Part) =>
				Effect.sync(() => {
					parts.push(part);
				}),
			),
		stderr: () => Sink.drain,
	});

const relayed = (steps: ReadonlyArray<Step>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const log = yield* fs.makeTempFileScoped();
		const input = yield* Queue.make<Uint8Array, Cause.Done>();
		const parts: Array<Part> = [];

		const running = yield* Effect.forkChild(
			Effect.provideService(teeWithHeartbeats(log), Stdio.Stdio, stdioOf(input, parts)),
		);

		yield* Effect.forEach(steps, fed(input, parts), { discard: true });
		yield* Queue.end(input);
		yield* Fiber.join(running);

		const pane = yield* Effect.promise(() => new Blob(parts).text());

		return { pane, log: yield* fs.readFileString(log) };
	}).pipe(Effect.scoped);

test("a quiet command's pane gets a heartbeat at 30 s, 1 m, 2 m and 5 m of quiet, and its log gets none", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { pane, log } = yield* relayed([{ print: "polling\n" }, { wait: "5 minutes" }]);

			const lines = [
				"polling",
				"⋯ still running after 30s, quiet for 30s",
				"⋯ still running after 1m00s, quiet for 1m00s",
				"⋯ still running after 2m00s, quiet for 2m00s",
				"⋯ still running after 5m00s, quiet for 5m00s",
				"",
			];

			expect(pane).toBe(Arr.join(lines, "\n"));
			expect(log).toBe("polling\n");
			expect(Arr.map(Str.split(pane, "\n"), isHeartbeat)).toEqual([false, true, true, true, true, false]);
		}).pipe(Effect.provide(world)),
	));

test("a heartbeat waits for a line's end, so it never splits a line or an escape sequence", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { pane } = yield* relayed([
				{ print: "waiting for postgres... " },
				{ wait: "10 minutes" },
				{ print: "up\n\u001B[" },
				{ wait: "10 minutes" },
				{ print: "0m\n" },
				{ wait: "30 seconds" },
			]);

			expect(pane).toBe("waiting for postgres... up\n\u001B[0m\n⋯ still running after 20m30s, quiet for 30s\n");
		}).pipe(Effect.provide(world)),
	));

test("output restarts the quiet count and the heartbeat schedule", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { pane } = yield* relayed([
				{ print: "a\n" },
				{ wait: "20 seconds" },
				{ print: "b\n" },
				{ wait: "30 seconds" },
				{ print: "c\n" },
				{ wait: "30 seconds" },
			]);

			const lines = [
				"a",
				"b",
				"⋯ still running after 50s, quiet for 30s",
				"c",
				"⋯ still running after 1m20s, quiet for 30s",
				"",
			];

			expect(pane).toBe(Arr.join(lines, "\n"));
		}).pipe(Effect.provide(world)),
	));
