import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";

import { ran, startCore } from "./core.ts";
import { layoutOf } from "./world.ts";

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);

		return true;
	} catch {
		return false;
	}
};

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

test("closing the core's scope ends the terminals it runs", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ directory: "/tmp" });
			const layout = layoutOf({ tmp, name: "core", stamp: "t", pid: process.pid, tag: "0abc12" });

			const env = {
				PATH: Bun.env["PATH"] ?? "",
				HOME: layout.home,
				XDG_RUNTIME_DIR: layout.runtime,
				HC_SESSION: layout.coreSession,
				HC_SOCKET: layout.socket,
			};

			const pidFile = `${tmp}/terminal.pid`;

			yield* Effect.forEach([layout.folder, layout.home, layout.runtime], (folder) =>
				fs.makeDirectory(folder, { recursive: true }),
			);

			const terminal = yield* Effect.gen(function* () {
				yield* startCore({ layout, env });
				yield* ran({ argv: ["hc", "run", "--bg", `echo $$ >${pidFile}; exec sleep 600`], env, cwd: layout.folder });
				yield* fs
					.exists(pidFile)
					.pipe(
						Effect.repeat({ until: (exists) => exists, schedule: Schedule.spaced("50 millis") }),
						Effect.timeout("5 seconds"),
					);

				return yield* Effect.map(fs.readFileString(pidFile), Number);
			}).pipe(Effect.scoped);

			expect(isAlive(terminal)).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	));
