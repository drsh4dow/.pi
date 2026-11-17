import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
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
>()("pi-harness/client/gh/Gh") {}

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

export const ghPassthrough = ({
	binary,
	args,
}: {
	readonly binary: string;
	readonly args: ReadonlyArray<string>;
}): Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => {
		const command = ChildProcess.make(binary, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });

		return Effect.scoped(Effect.flatMap(spawner.spawn(command), (handle) => handle.exitCode));
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

const gh = (args: ReadonlyArray<string>) => output("gh", args);

const json = <Value>(args: ReadonlyArray<string>, decode: (stdout: string) => Result.Result<Value, Error>) =>
	Effect.flatMap(gh(args), (stdout) =>
		Effect.mapError(Effect.fromResult(decode(stdout)), ({ message }) =>
			GhError.make({ args: ["gh", ...args], why: message }),
		),
	);

const view = (pr: string) =>
	Effect.flatMap(gh(["pr", "view", pr, "--json", fields]), (stdout) =>
		Effect.mapError(Effect.fromResult(viewOf(stdout)), (why) =>
			GhError.make({ args: ["gh", "pr", "view", pr], why }),
		),
	);

const mergeBaseAndHeadOf = (pr: string) =>
	Effect.gen(function* () {
		const { repo, url, head } = yield* view(pr);
		const base = yield* Effect.map(gh(["pr", "view", pr, "--json", "baseRefOid", "--jq", ".baseRefOid"]), Str.trim);
		const compare = `repos/${repo}/compare/${base}...${head}`;
		const mergeBase = yield* Effect.map(gh(["api", compare, "--jq", ".merge_base_commit.sha"]), Str.trim);

		return { remote: Str.replace(/\/pull\/\d+$/u, ".git")(url), mergeBase, head };
	});

const auth = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

const fetchedDiff = (pr: string) =>
	Effect.gen(function* () {
		const { remote, mergeBase, head } = yield* mergeBaseAndHeadOf(pr);

		const dir = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
			Effect.mapError(fs.makeTempDirectoryScoped(), ({ message }) =>
				GhError.make({ args: ["mktemp"], why: message }),
			),
		);

		const git = (args: ReadonlyArray<string>) => output("git", ["-C", dir, ...args]);

		yield* git(["init", "-q", "--bare"]);
		yield* git([...auth, "fetch", "-q", "--depth=1", "--no-tags", remote, mergeBase, head]);

		// `--full-index` keeps a binary change, whose diff is only its blob ids, from sharing an id with another blob of the same abbreviation.
		return yield* git(["diff-tree", "-p", "-M", "--full-index", mergeBase, head]);
	}).pipe(Effect.scoped);

const tooLarge = ({ why }: GhError) => Str.includes("PullRequest.diff too_large")(why);

const patchId = (pr: string) =>
	gh(["pr", "diff", pr]).pipe(
		Effect.catchIf(tooLarge, () => fetchedDiff(pr)),
		Effect.flatMap(patchIdOf),
	);

const stackOf = (ceiling: string) => {
	const stacks = "repos/{owner}/{repo}/stacks";
	const byNumber = json(["api", `${stacks}/${ceiling}`], decodeStack);

	return json(["api", `${stacks}?pull_request=${ceiling}`], decodeStacks).pipe(
		Effect.flatMap((found) => Option.match(Arr.head(found), { onNone: () => byNumber, onSome: Effect.succeed })),
		Effect.map(membersOf),
	);
};

type Services = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem;

export const ghLayer: Layer.Layer<Gh, never, Services> = Layer.effect(
	Gh,
	Effect.map(Effect.context<Services>(), (context) =>
		Gh.of({
			view: (pr) => Effect.provide(view(pr), context),
			patchId: (pr) => Effect.provide(patchId(pr), context),
			stackOf: (ceiling) => Effect.provide(stackOf(ceiling), context),
		}),
	),
);
