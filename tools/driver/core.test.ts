import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { ran } from "./core.ts";
import { layoutOf } from "./world.ts";

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);

		return true;
	} catch {
		return false;
	}
};

const layoutIn = (tmp: string) => layoutOf({ tmp, name: "guardian", stamp: "0", pid: 0, tag: "000000" });

/** A driver that starts its core under the guardian, with no hc on PATH, prints ready, and waits. */
const driverOf = (tmp: string) => `
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { startCore } from "${import.meta.dirname}/core.ts";
import { layoutOf } from "${import.meta.dirname}/world.ts";
const layout = layoutOf({ tmp: "${tmp}", name: "guardian", stamp: "0", pid: 0, tag: "000000" });
const env = { PATH: "${tmp}/bin:/usr/bin:/bin", HOME: layout.home, HC_SOCKET: layout.socket };
await Effect.runPromise(startCore({ layout, env }).pipe(
	Effect.andThen(Effect.sync(() => console.log("ready"))),
	Effect.andThen(Effect.never),
	Effect.scoped,
	Effect.provide(NodeServices.layer),
));
`;

/** A herdr-core that records its pid, makes its socket file and runs until a signal ends it. */
const standIn = (pidFile: string) =>
	`#!/bin/sh\necho $$ >"${pidFile}"\nmkdir -p "$(dirname "$HC_SOCKET")"\ntouch "$HC_SOCKET"\nexec sleep 600\n`;

/** Kills the driver with SIGKILL once its core is up, so none of its finalizers run. */
const killedOnceReady = (tmp: string) =>
	Effect.gen(function* () {
		const driver = Bun.spawn(["bun", "-e", driverOf(tmp)], { cwd: import.meta.dirname, stdout: "pipe" });

		yield* Stream.fromReadableStream({ evaluate: () => driver.stdout, onError: String }).pipe(
			Stream.decodeText,
			Stream.takeUntil(Str.includes("ready")),
			Stream.runDrain,
		);

		driver.kill("SIGKILL");
		yield* Effect.promise(() => driver.exited);
	});

test("a driver killed outright stops its core even when hc cannot, and removes the core's folder after", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ directory: "/tmp" });

			yield* fs.makeDirectory(`${tmp}/bin`);
			yield* fs.makeDirectory(layoutIn(tmp).folder, { recursive: true });
			yield* fs.writeFileString(`${tmp}/bin/herdr-core`, standIn(`${tmp}/core.pid`), { mode: 0o755 });
			yield* killedOnceReady(tmp);
			yield* Effect.sleep("1 second");

			const pid = yield* Effect.map(fs.readFileString(`${tmp}/core.pid`), Number);
			const folderLeft = yield* fs.exists(layoutIn(tmp).runtime);

			expect([isAlive(pid), folderLeft]).toEqual([false, false]);
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	));

test("a timeout around ran ends a command that ignores SIGTERM", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const command = {
				argv: ["sh", "-c", "trap '' TERM; sleep 30"] as const,
				env: { PATH: Bun.env["PATH"] ?? "" },
				cwd: "/",
			};

			const [took] = yield* Effect.timed(ran(command).pipe(Effect.timeout("100 millis"), Effect.ignore));

			expect(took.pipe(Duration.toMillis)).toBeLessThan(4000);
		}).pipe(Effect.provide(NodeServices.layer)),
	));
