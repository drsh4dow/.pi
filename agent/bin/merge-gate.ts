import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ghPassthrough } from "#src/client/gh/index.ts";
import { Authorization, gate, ghLayer, mergeRequestOf, verdictsFolder } from "#src/features/pr/index.ts";

const [real = "gh", ...args] = process.argv.slice(2);

const exitWith = (code: number) =>
	Effect.sync(() => {
		process.exitCode = code;
	});

const runReal = (argv: ReadonlyArray<string>) => Effect.flatMap(ghPassthrough({ binary: real, args: argv }), exitWith);

const gated = (request: Parameters<ReturnType<typeof gate>>[0]) =>
	Effect.gen(function* () {
		const home = yield* Config.String("HOME");
		const authorization = yield* gate(verdictsFolder(home))(request);

		yield* Authorization.$match(authorization, {
			Allow: ({ pin }) => runReal([...args, ...pin]),
			Refuse: ({ why }) => Effect.andThen(Console.error(why), exitWith(1)),
		});
	});

const program = Option.match(mergeRequestOf(args), { onNone: () => runReal(args), onSome: gated });

NodeRuntime.runMain(Effect.provide(program, Layer.provideMerge(ghLayer, NodeServices.layer)));
