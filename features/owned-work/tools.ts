import { type JsonValue, uuidv7 } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { type Static, Type } from "typebox";

import type { ChildSession } from "./child.ts";
import type { Entry } from "./delegates.ts";
import { Ledger, type LedgerFailure } from "./ledger.ts";
import { HandleOut, Out, ResultsOut } from "./out.ts";
import { StartRequest, WorkRef } from "./work.ts";

const HandleRef = Type.Object({ ref: Type.String() });

const Refs = Type.Array(HandleRef, { minItems: 1 });

const RefsParams = Type.Object({ of: Refs });

const Message = Type.String({
	minLength: 1,
	description: "Everything the delegate needs. You cannot send it anything later, and it cannot ask you.",
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

const resultOf = (json: JsonValue, isError: boolean) =>
	Effect.map(Out.text(json), (text) => ({
		content: [{ type: "text" as const, text }],
		details: json,
		structuredContent: json,
		isError,
	}));

type Runtime = ManagedRuntime.ManagedRuntime<Ledger, never>;

type Call<Reply> = (ledger: (typeof Ledger)["Service"]) => Effect.Effect<Reply, LedgerFailure>;

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

const descriptionOf = (entries: ReadonlyArray<Entry>) =>
	Arr.join(
		Arr.map(entries, ({ name, config }) => `- ${name}: ${config.description}`),
		"\n",
	);

const delegateTool = (runtime: Runtime, entries: ReadonlyArray<Entry>, place: Omit<ChildSession, "id">) => {
	const start = (name: string, message: string) => (ledger: (typeof Ledger)["Service"]) =>
		Option.match(
			Arr.findFirst(entries, (entry) => entry.name === name),
			{
				onNone: () => Effect.die(`no delegate ${name}`),
				onSome: (entry) => {
					const childSession = { ...place, id: uuidv7() };

					return ledger.start(StartRequest.Delegate({ entry, message, childSession }));
				},
			},
		);

	const names = Arr.map(entries, ({ name }) => name);

	return defineTool({
		name: "delegate",
		label: "delegate",
		promptSnippet: "Start a delegate on one task. It wakes you with its answer.",
		description: `Start a delegate on one task. It wakes you with its answer. Delegates:\n${descriptionOf(entries)}`,
		parameters: Type.Object({ delegate: Type.Enum(names), message: Message }),
		outputSchema: HandleOut,
		execute: (_id, { delegate, message }, signal) =>
			runTool(runtime, signal)(start(String(delegate), message), Out.handle),
	});
};

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
	pi: ExtensionAPI,
	runtime: Runtime,
	entries: ReadonlyArray<Entry>,
	place: Omit<ChildSession, "id">,
) => {
	pi.registerTool(serveTool(runtime));
	pi.registerTool(watchTool(runtime));
	pi.registerTool(groupTool(runtime));
	pi.registerTool(stopTool(runtime));

	if (Arr.isReadonlyArrayNonEmpty(entries)) {
		pi.registerTool(delegateTool(runtime, entries, place));
	}
};

export const Tools = { register };
