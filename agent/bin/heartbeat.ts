import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { teeWithHeartbeats } from "#src/client/heartbeat/index.ts";

const [log] = process.argv.slice(2);

const usage = Effect.andThen(
	Console.error("usage: heartbeat <log>"),
	Effect.sync(() => {
		process.exitCode = 2;
	}),
);

NodeRuntime.runMain(Effect.provide(log === undefined ? usage : teeWithHeartbeats(log), NodeServices.layer));
