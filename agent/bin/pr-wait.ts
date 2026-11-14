import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ghLayer, prWait } from "../../features/pr/index.ts";

const reportFailure = (message: string) =>
	Effect.andThen(
		Console.error(message),
		Effect.sync(() => {
			process.exitCode = 2;
		}),
	);

const prs = process.argv.slice(2);

const program = Arr.isReadonlyArrayNonEmpty(prs)
	? prWait(prs).pipe(
			Effect.flatMap((lines) => Console.log(Arr.join(lines, "\n"))),
			Effect.catchTag("GhError", ({ args, why }) =>
				reportFailure(`pr-wait: gh ${Arr.join(args, " ")} failed: ${why}`),
			),
		)
	: reportFailure("usage: pr-wait <pull request>...");

NodeRuntime.runMain(Effect.provide(program, Layer.provide(ghLayer, NodeServices.layer)));
