import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { fields, type PrView, viewOf } from "./view.ts";

export type { PrView, Review, ReviewDecision } from "./view.ts";

export interface StackMember {
	readonly number: string;
	readonly state: string;
}

export class GhError extends Schema.TaggedError<GhError, { readonly brand: unique symbol }>()("GhError", {
	args: Schema.Array(Schema.String),
	why: Schema.String,
}) {}

export class Gh extends Context.Service<
	Gh,
	{
		/** `pr` is a number, a URL or a branch, as gh resolves it in the current directory. */
		readonly view: (pr: string) => Effect.Effect<PrView, GhError>;
		readonly patchId: (pr: string) => Effect.Effect<string, GhError>;
		/** The pull requests of the stack numbered `ceiling`, or else of the stack that holds pull request `ceiling`, bottom first. */
		readonly stackOf: (ceiling: string) => Effect.Effect<ReadonlyArray<StackMember>, GhError>;
	}
>()("pi-harness/clients/gh/Gh") {}

const text = <Failure>(stream: Stream.Stream<Uint8Array, Failure>) => stream.pipe(Stream.decodeText, Stream.mkString);

const output = (command: string, args: ReadonlyArray<string>, input = "") =>
	Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => {
		const failed = (why: string) => GhError.make({ args: [command, ...args], why });
		const stdin = Stream.make(new TextEncoder().encode(input));

		return spawner.spawn(ChildProcess.make(command, args, { stdin })).pipe(
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
			Effect.map(({ stdout }) => stdout),
		);
	});

/**
 * `git patch-id --verbatim` over a diff with its context lines. It is strict on purpose: whitespace counts, and a base
 * that changed a line next to the patch changes the id too, so a verdict carries only across a rebase that left the
 * whole diff as it was.
 */
export const patchIdOf = (diff: string) =>
	output("git", ["patch-id", "--verbatim"], diff).pipe(
		Effect.map((line) => Arr.headNonEmpty(Str.split(Str.trim(line), " "))),
		Effect.filterOrFail(Str.isNonEmpty, () => GhError.make({ args: ["git", "patch-id"], why: "the diff is empty" })),
	);

const Stack = Schema.Struct({
	pull_requests: Schema.Array(Schema.Struct({ number: Schema.Finite, state: Schema.String })),
});

const decodeStack = Schema.decodeUnknownResult(Schema.fromJsonString(Stack));

const decodeStacks = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Array(Stack)));

const membersOf = ({ pull_requests }: typeof Stack.Type): ReadonlyArray<StackMember> =>
	Arr.map(pull_requests, ({ number, state }) => ({ number: String(number), state }));

export const ghLayer: Layer.Layer<Gh, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
	Gh,
	Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) => {
		const gh = (args: ReadonlyArray<string>) =>
			Effect.provideService(output("gh", args), ChildProcessSpawner.ChildProcessSpawner, spawner);

		const json = <Value>(args: ReadonlyArray<string>, decode: (stdout: string) => Result.Result<Value, Error>) =>
			Effect.flatMap(gh(args), (stdout) =>
				Effect.mapError(Effect.fromResult(decode(stdout)), ({ message }) =>
					GhError.make({ args: ["gh", ...args], why: message }),
				),
			);

		return Gh.of({
			view: (pr) =>
				Effect.flatMap(gh(["pr", "view", pr, "--json", fields]), (stdout) =>
					Effect.mapError(Effect.fromResult(viewOf(stdout)), (why) =>
						GhError.make({ args: ["gh", "pr", "view", pr], why }),
					),
				),
			patchId: (pr) =>
				Effect.flatMap(gh(["pr", "diff", pr]), (diff) =>
					Effect.provideService(patchIdOf(diff), ChildProcessSpawner.ChildProcessSpawner, spawner),
				),
			stackOf: (ceiling) => {
				const stacks = "repos/{owner}/{repo}/stacks";
				const byNumber = json(["api", `${stacks}/${ceiling}`], decodeStack);

				return json(["api", `${stacks}?pull_request=${ceiling}`], decodeStacks).pipe(
					Effect.flatMap((found) =>
						Option.match(Arr.head(found), { onNone: () => byNumber, onSome: Effect.succeed }),
					),
					Effect.map(membersOf),
				);
			},
		});
	}),
);
