import { type JsonValue, uuidv7 } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import { type Static, Type } from "typebox";

import { type Caller, type DelegateParams, delegateParams, parseCall } from "./brief.ts";
import { type ChildSession, levels, mayDelegate, type Self } from "./child.ts";
import { Ledger, type LedgerFailure } from "./ledger.ts";
import { type ModelTable, modelTable } from "./models.ts";
import { HandleOut, Out, ResultsOut } from "./out.ts";
import { type BadDelegate, StartRequest, WorkRef } from "./work.ts";

const HandleRef = Type.Object({ ref: Type.String() });

const Refs = Type.Array(HandleRef, { minItems: 1 });

const RefsParams = Type.Object({ of: Refs });

const ServeParams = Type.Object({
	command: Type.String({ minLength: 1 }),
	ready: Type.Optional(
		Type.String({ description: "Output text that means it is up. The call returns once it appears (60 s at most)." }),
	),
});

const WatchParams = Type.Object({
	command: Type.String({
		minLength: 1,
		description: "Write it as you would run it. The wake carries its exit code, last lines, and log path.",
	}),
	deadline: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, description: "Seconds. Only for commands that might hang." }),
	),
});

const GroupParams = Type.Object({
	name: Type.String({
		pattern: String.raw`\S`,
		description:
			"A few words for what the group's work has in common, such as `principles eval`. The human sees its members under it in their list of running agents.",
	}),
	of: Refs,
});

const promptGuidelines = ["Starting work returns a handle at once. To wait, end your turn; each result wakes you."];

/** Only an agent that may start delegates gets these, since pi shows a tool's guidelines only while the tool is active. */
const delegateGuidelines = [
	"Decide what goes to a delegate before you start, while your context is small. Work of a handful of tool calls, or that needs context a task message cannot carry, stays with you.",
	"Reading of more than about 1,500 lines, or of three or more areas, goes to delegates, one per area in parallel, each asked for the facts you need with file, line, and quotes. This holds when the reading serves your own plan. Context spent on reading never comes back, so read yourself only what you will edit.",
	"Run independent parts, where no two write the same file and none needs another's result, as delegates started in one turn with one `group` name.",
	"Hand implementation to one owner per slice when a slice has written acceptance criteria or the work has two or more slices. Coupled code gets one owner.",
	"Write each delegate task message as the delegate's whole world. Name the user's goal, the task, the inputs as file paths, what counts as done, and the shape of the answer.",
	"Give each delegate that commits its own branch or worktree, and start it there with cwd.",
	"A delegate's answer is a claim. Check what you will act on against the real artifact before you report it as done.",
	"A delegate that reports something missing hands you a gap. Supply it in a fresh delegate's message. If only someone above you can settle it, it is your own open question now.",
];

const nestingGuideline =
	"An owner you start can start delegates of its own, so hand it its whole slice. A leaf cannot.";

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

const delegateTool = (
	runtime: Runtime,
	childLevel: number,
	place: Omit<ChildSession, "id">,
	table: ModelTable = modelTable,
) => {
	const parameters = delegateParams(table);

	return {
		name: "delegate",
		label: "delegate",
		description: "Start a delegate on one task. It wakes you with its answer.",
		promptGuidelines: [...delegateGuidelines, childLevel === levels ? lastLevelGuideline : nestingGuideline],
		parameters,
		outputSchema: HandleOut,
		execute: (_id, call, signal, _update, ctx: Caller) =>
			runTool(runtime, signal)(
				(ledger) =>
					Effect.flatMap(parseCall(ctx, table, call), ({ brief, cwd }) =>
						ledger.start(
							StartRequest.Delegate({
								brief,
								childSession: { ...place, cwd: Option.getOrElse(cwd, () => place.cwd), id: uuidv7() },
								group: Option.fromUndefinedOr(call.group),
							}),
						),
					),
				Out.handle,
			),
	} satisfies ToolDefinition<DelegateParams, JsonValue>;
};

const serveTool = (runtime: Runtime) =>
	defineTool({
		name: "serve",
		label: "serve",
		description:
			"Start a long-running command, such as a dev server. It runs until you cancel it, or until the group holding it settles.",
		promptGuidelines,
		parameters: ServeParams,
		outputSchema: HandleOut,
		execute: (_id, { command, ready }, signal) =>
			runTool(runtime, signal)(
				(ledger) => ledger.start(StartRequest.Serve({ command, ready: Option.fromUndefinedOr(ready) })),
				Out.handle,
			),
	});

/** A watch's log sits beside the delegate sessions of the session that started it, and stays as long as they do. */
const watchTool = (runtime: Runtime, place: Omit<ChildSession, "id">) =>
	defineTool({
		name: "watch",
		label: "watch",
		description: "Start a command that wakes you once it exits, with its exit code, last lines, and log path.",
		parameters: WatchParams,
		outputSchema: HandleOut,
		execute: (_id, { command, deadline }, signal) => {
			const after = Option.map(Option.fromUndefinedOr(deadline), Duration.seconds);
			const request = StartRequest.Watch({ command, deadline: after, log: `${place.dir}/${uuidv7()}.log` });

			const ownerOnlyDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
				fs.makeDirectory(place.dir, { recursive: true, mode: 0o700 }),
			);

			return runTool(runtime, signal)((ledger) => Effect.andThen(ownerOnlyDir, ledger.start(request)), Out.handle);
		},
	});

const groupTool = (runtime: Runtime) =>
	defineTool({
		name: "group",
		label: "group",
		description: "Move work you hold into one group, which wakes you instead of its members.",
		parameters: GroupParams,
		outputSchema: HandleOut,
		execute: (_id, { name, of }, signal) =>
			runTool(runtime, signal)((ledger) => ledger.group({ name, members: refsOf(of) }), Out.handle),
	});

const cancelTool = (runtime: Runtime) =>
	defineTool({
		name: "cancel",
		label: "cancel",
		description:
			"Cancel work and everything a group holds, killing its processes. Returns results not yet woken to you.",
		parameters: RefsParams,
		outputSchema: ResultsOut,
		execute: (_id, { of }, signal) =>
			runTool(runtime, signal)(
				(ledger) => ledger.cancel(refsOf(of)),
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
	pi.registerTool(watchTool(runtime, place));
	pi.registerTool(groupTool(runtime));
	pi.registerTool(cancelTool(runtime));

	if (mayDelegate(self)) {
		pi.registerTool(delegateTool(runtime, self.level + 1, place));
	}
};

export const Tools = { register, delegate: delegateTool };
