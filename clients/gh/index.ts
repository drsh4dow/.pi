import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { fields, type PrView, viewOf } from "./view.ts";

export type { Checks, PrState, PrView, Review, ReviewDecision } from "./view.ts";

export class GhError extends Schema.TaggedError<GhError, { readonly brand: unique symbol }>()("GhError", {
	args: Schema.Array(Schema.String),
	why: Schema.String,
}) {}

export class Gh extends Context.Service<
	Gh,
	{
		/** `pr` is a number, a URL or a branch, as gh resolves it in the current directory. */
		readonly view: (pr: string) => Effect.Effect<PrView, GhError>;
	}
>()("pi-harness/clients/gh/Gh") {}

const text = <Failure>(stream: Stream.Stream<Uint8Array, Failure>) => stream.pipe(Stream.decodeText, Stream.mkString);

export const ghLayer: Layer.Layer<Gh, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
	Gh,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		return Gh.of({
			view: (pr) => {
				const args = ["pr", "view", pr, "--json", fields];
				const failed = (why: string) => GhError.make({ args, why });

				return spawner.spawn(ChildProcess.make("gh", args)).pipe(
					Effect.flatMap((handle) =>
						Effect.all(
							{ code: handle.exitCode, stdout: text(handle.stdout), stderr: text(handle.stderr) },
							{ concurrency: 3 },
						),
					),
					Effect.scoped,
					Effect.mapError((error) => failed(error.message)),
					Effect.filterOrFail(
						({ code }) => code === 0,
						({ stderr }) => failed(Str.trim(stderr)),
					),
					Effect.flatMap(({ stdout }) => Effect.mapError(Effect.fromResult(viewOf(stdout)), failed)),
				);
			},
		});
	}),
);
