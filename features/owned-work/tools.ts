import { type JsonValue, uuidv7 } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Str from "effect/String";
import { type Static, Type } from "typebox";

import { type Brief, type ChildSession, levels, type Self } from "./child.ts";
import { Ledger, type LedgerFailure } from "./ledger.ts";
import { nameOf } from "./naming.ts";
import { HandleOut, Out, ResultsOut } from "./out.ts";
import { BadDelegate, StartRequest, WorkRef } from "./work.ts";

const HandleRef = Type.Object({ ref: Type.String() });

const Refs = Type.Array(HandleRef, { minItems: 1 });

const RefsParams = Type.Object({ of: Refs });

const DelegateParams = Type.Object({
	message: Type.String({
		pattern: String.raw`\S`,
		description: "Everything the delegate needs. You cannot send it anything later, and it cannot ask you.",
	}),
	instructionsFile: Type.Optional(
		Type.String({
			description:
				"A file whose text the delegate keeps as standing instructions, such as one a skill names. `~/` and paths relative to your working directory work.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"`provider/id`, such as anthropic/claude-opus-5-5. Your own model and thinking level when left out.",
		}),
	),
});

const ServeParams = Type.Object({
	command: Type.String({ minLength: 1 }),
	ready: Type.Optional(
		Type.String({ description: "Output text that means it is up. The call returns once it appears (60 s at most)." }),
	),
});

const WatchParams = Type.Object({
	command: Type.String({ minLength: 1 }),
	deadline: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, description: "Seconds. Only for commands that might hang." }),
	),
});

const GroupParams = Type.Object({
	mode: Type.Enum(["all", "each"], {
		description: "all: one wake with every result once all settle. each: one wake per result.",
	}),
	of: Refs,
});

const promptGuidelines = [
	"Starting work returns a handle at once. End your turn to be woken with results; do not poll.",
	"Use group(mode, of: [handles]) to scope work: a group stops its serves when its jobs settle. Work you never group is yours and wakes you itself.",
];

/** Only an agent that may start delegates gets these, since pi shows a tool's guidelines only while the tool is active. */
const delegateGuidelines = [
	"Use delegate to keep bulk out of your context. When the work means reading many files, a long transcript, or a large artifact, hand it to a delegate and keep only its answer and the evidence locations it names.",
	"Treat every delegate hand-off as lossy. One agent, one round trip, is the baseline. Fan out only when the sub-tasks are independent (no shared mutable state, no ordering between them), each delegate brings back a different kind of finding, and merging the answers fits in your context.",
	"Write each delegate task message as the delegate's whole world. Name the goal, the inputs, what counts as done, and the shape of the answer.",
	"Give each delegate that commits its own branch or worktree.",
	"A delegate's answer is a claim. Check what you will act on against the real artifact before you report it as done.",
	"A delegate that reports something missing hands you a gap. Supply it in a fresh delegate's message. If only someone above you can settle it, it is your own open question now.",
];

const lastLevelGuideline =
	"Your delegates cannot start delegates of their own, so give each one work it can finish alone.";

const resultOf = (json: JsonValue, isError: boolean) =>
	Effect.map(Out.text(json), (text) => ({
		content: [{ type: "text" as const, text }],
		details: json,
		structuredContent: json,
		isError,
	}));

type Runtime = ManagedRuntime.ManagedRuntime<Ledger | FileSystem.FileSystem | Path.Path, never>;

type Call<Reply> = (
	ledger: (typeof Ledger)["Service"],
) => Effect.Effect<Reply, LedgerFailure | BadDelegate, FileSystem.FileSystem | Path.Path>;

const runTool =
	(runtime: Runtime, signal: AbortSignal | undefined) =>
	<Reply>(call: Call<Reply>, render: (reply: Reply) => JsonValue) =>
		runtime.runPromise(
			Effect.matchEffect(Effect.flatMap(Ledger, call), {
				onFailure: (error) => resultOf(Out.error(error), true),
				onSuccess: (reply) => resultOf(render(reply), false),
			}),
			{ signal },
		);

const refsOf = (of: ReadonlyArray<Static<typeof HandleRef>>) => Arr.map(of, ({ ref }) => WorkRef(ref));

type Caller = Pick<ExtensionContext, "cwd" | "model" | "thinkingLevel"> & {
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAll" | "streamSimple">;
};

const modelOf = (ctx: Caller, wanted: string | undefined) => {
	if (wanted === undefined) {
		const own = Option.fromUndefinedOr(ctx.model);
		const thinking = Option.fromUndefinedOr(ctx.thinkingLevel);

		return Effect.fromOption(own, () => BadDelegate.make({ why: "name a model, since you run on none" })).pipe(
			Effect.map(({ provider, id }) => ({ model: `${provider}/${id}`, thinking })),
		);
	}

	const found = Arr.findFirst(ctx.modelRegistry.getAll(), ({ provider, id }) => `${provider}/${id}` === wanted);

	return Effect.fromOption(found, () =>
		BadDelegate.make({ why: `model ${wanted} is not in the model registry` }),
	).pipe(Effect.as({ model: wanted, thinking: Option.none<string>() }));
};

const instructionsOf = Effect.fn("instructionsOf")(function* (cwd: string, file: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const home = yield* Effect.orElseSucceed(Config.String("HOME"), () => "~");
	const absolute = path.resolve(cwd, Str.replace(/^~(?=\/)/u, home)(file));

	const text = yield* Effect.mapError(fs.readFileString(absolute), (error) =>
		BadDelegate.make({ why: `cannot read instructionsFile ${file}: ${error.reason._tag}` }),
	);

	return { file: absolute, text };
});

const briefOf = Effect.fn("briefOf")(function* (ctx: Caller, call: Static<typeof DelegateParams>) {
	const { model, thinking } = yield* modelOf(ctx, call.model);

	const instructions = yield* Effect.transposeOption(
		Option.map(Option.fromUndefinedOr(call.instructionsFile), (file) => instructionsOf(ctx.cwd, file)),
	);

	const name = yield* nameOf(ctx.modelRegistry, ctx.model, call.message);

	return { name, message: call.message, model, thinking, instructions } satisfies Brief;
});

const delegateTool = (runtime: Runtime, childLevel: number, place: Omit<ChildSession, "id">) =>
	({
		name: "delegate",
		label: "delegate",
		promptSnippet: "Start a delegate on one task. It wakes you with its answer.",
		description: "Start a delegate on one task. It wakes you with its answer.",
		promptGuidelines: childLevel === levels ? [...delegateGuidelines, lastLevelGuideline] : delegateGuidelines,
		parameters: DelegateParams,
		outputSchema: HandleOut,
		execute: (_id, call, signal, _update, ctx: Caller) =>
			runTool(runtime, signal)(
				(ledger) =>
					Effect.flatMap(briefOf(ctx, call), (brief) =>
						ledger.start(StartRequest.Delegate({ brief, childSession: { ...place, id: uuidv7() } })),
					),
				Out.handle,
			),
	}) satisfies ToolDefinition<typeof DelegateParams, JsonValue>;

const serveTool = (runtime: Runtime) =>
	defineTool({
		name: "serve",
		label: "serve",
		promptSnippet: "Run a long-running command, such as a dev server.",
		description:
			"Start a long-running command, such as a dev server. It runs until you stop it, or until the group holding it settles.",
		promptGuidelines,
		parameters: ServeParams,
		outputSchema: HandleOut,
		execute: (_id, { command, ready }, signal) =>
			runTool(runtime, signal)(
				(ledger) => ledger.start(StartRequest.Serve({ command, ready: Option.fromUndefinedOr(ready) })),
				Out.handle,
			),
	});

const watchTool = (runtime: Runtime) =>
	defineTool({
		name: "watch",
		label: "watch",
		promptSnippet: "Run a command that wakes you once it exits.",
		description: "Start a command that wakes you once it exits, with its exit code and last lines.",
		parameters: WatchParams,
		outputSchema: HandleOut,
		execute: (_id, { command, deadline }, signal) => {
			const after = Option.map(Option.fromUndefinedOr(deadline), Duration.seconds);

			return runTool(runtime, signal)(
				(ledger) => ledger.start(StartRequest.Watch({ command, deadline: after })),
				Out.handle,
			);
		},
	});

const groupTool = (runtime: Runtime) =>
	defineTool({
		name: "group",
		label: "group",
		promptSnippet: "Gather work you hold so it wakes you as one result, or once per job.",
		description: "Move work you hold into one group, which wakes you instead of its members.",
		parameters: GroupParams,
		outputSchema: HandleOut,
		execute: (_id, { mode, of }, signal) =>
			runTool(runtime, signal)((ledger) => ledger.group(mode, refsOf(of)), Out.handle),
	});

const stopTool = (runtime: Runtime) =>
	defineTool({
		name: "stop",
		label: "stop",
		promptSnippet: "Stop work and get back any result not yet handed to you.",
		description: "Stop work, and everything a group holds. Returns any result not yet handed to you.",
		parameters: RefsParams,
		outputSchema: ResultsOut,
		execute: (_id, { of }, signal) =>
			runTool(runtime, signal)(
				(ledger) => ledger.stop(refsOf(of)),
				(results) => ({ results: Arr.map(results, Out.result) }),
			),
	});

const register = (
	pi: Pick<ExtensionAPI, "registerTool">,
	runtime: Runtime,
	self: Self,
	place: Omit<ChildSession, "id">,
) => {
	pi.registerTool(serveTool(runtime));
	pi.registerTool(watchTool(runtime));
	pi.registerTool(groupTool(runtime));
	pi.registerTool(stopTool(runtime));

	if (self.level < levels) {
		pi.registerTool(delegateTool(runtime, self.level + 1, place));
	}
};

export const Tools = { register, delegate: delegateTool };
