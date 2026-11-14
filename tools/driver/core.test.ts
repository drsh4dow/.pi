import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { ran } from "./core.ts";

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
