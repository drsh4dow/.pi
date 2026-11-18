import { type JsonValue, uuidv7 } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { type Static, Type } from "typebox";

import { type BriefSources, briefSourcesLayer } from "#src/client/brief-sources/index.ts";
import { type Gh, ghLayer } from "#src/client/gh/index.ts";
import { makeSessionFolder, readStagedBrief } from "#src/client/pi-cli/index.ts";
import type { PiHost } from "#src/client/pi-host/index.ts";
import type { SessionAddress } from "#src/client/pi-sessions/index.ts";
import { type Caller, type DelegateParams, delegateParams, parseCall } from "./brief.ts";
import { type ChildRole, type ChildSession, childRoles, Self } from "./child.ts";
import { freshCall, parseContinuation } from "./continuation.ts";
import { Ledger, type LedgerFailure } from "./ledger.ts";
import { modelNameOf, modelOf, type ModelTable, modelTable } from "./models.ts";
import { HandleOut, Out, ResultsOut } from "./out.ts";
import { stdoutRedirectOf } from "./redirect.ts";
import { withReview } from "./review.ts";
import { BadDelegate, StartRequest, WorkRef } from "./work.ts";

const HandleRef = Type.Object({ ref: Type.String() });

const Refs = Type.Array(HandleRef, { minItems: 1 });

const RefsParams = Type.Object({ of: Refs });

const CommandName = Type.String({
	pattern: String.raw`\S`,
	description:
		"A few words that tell this command apart from the others you run, such as `dev server` or `unit tests`. The human sees it in their list of running agents and on its pane.",
});

const ServeParams = Type.Object({
	name: CommandName,
	command: Type.String({
		minLength: 1,
		description:
			"Run it as is and let it print, rather than redirecting, filtering or silencing it. Pipe it through `tee <file>` to keep a copy. A loop should print one line per pass, so the pane shows it is alive.",
	}),
	ready: Type.Optional(
		Type.String({ description: "Output text that means it is up. The call returns once it appears (60 s at most)." }),
	),
});

const WatchParams = Type.Object({
	name: CommandName,
	command: Type.String({
		minLength: 1,
		description:
			"Run it as is and let it print, rather than redirecting, filtering or silencing it. The wake already carries what you need. A loop should print one line per pass, so the pane shows it is alive.",
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
	"Write each delegate task message as the delegate's whole world. Name the task, the inputs as file paths, what counts as done, and the shape of the answer.",
	"Give each delegate that commits its own branch or worktree, and start it there with cwd.",
	"A delegate's answer is a claim. Check what you will act on against the real artifact before you report it as done.",
	"A delegate that reports something missing hands you a gap. Supply it in a fresh delegate's message. If only someone above you can settle it, it is your own open question now.",
];

/** Only an agent that may start owners gets these. */
const ownerGuidelines = [
	"Hand implementation to one owner per slice when a slice has written acceptance criteria or the work has two or more slices. Coupled code gets one owner.",
	"An owner you start can start delegates of its own, so hand it its whole slice. A leaf cannot.",
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

type CallServices = Gh | BriefSources | NodeServices.NodeServices;

type Runtime = PiHost<Ledger | CallServices, never>;

type Call<Reply> = (
	ledger: (typeof Ledger)["Service"],
) => Effect.Effect<Reply, LedgerFailure | BadDelegate, CallServices>;

const runTool =
	(runtime: Runtime, signal: AbortSignal | undefined) =>
	<Reply>(call: Call<Reply>, render: (reply: Reply) => JsonValue) => {
		const tool = Effect.matchEffect(Effect.flatMap(Ledger, call), {
			onFailure: (error) => resultOf(Out.error(error), true),
			onSuccess: (reply) => resultOf(render(reply), false),
		});

		return runtime.run(tool, { signal });
	};

const refsOf = (of: ReadonlyArray<Static<typeof HandleRef>>) => Arr.map(of, ({ ref }) => WorkRef(ref));

type OwnSession = Pick<SessionAddress, "dir" | "id">;

const ownBrief = (ownSession: Option.Option<OwnSession>) =>
	Effect.transposeOption(
		Option.map(ownSession, (session) =>
			Effect.mapError(readStagedBrief(session), ({ file, why }) =>
				BadDelegate.make({ why: `cannot read your own brief ${file}: ${why}` }),
			),
		),
	);

/** Runs a settled delegate again in its own session, on the model the PHI gate allows for its brief's model now. */
const relaunched = Effect.fn("relaunched")(function* ({
	ledger,
	ctx,
	table,
	ref,
	call,
}: {
	readonly ledger: (typeof Ledger)["Service"];
	readonly ctx: Caller;
	readonly table: ModelTable;
	readonly ref: string;
	readonly call: Static<DelegateParams>;
}) {
	const request = yield* parseContinuation(ref, call);
	const continuation = yield* ledger.continuation(request);
	const { model, substitution } = yield* modelOf(ctx, table, modelNameOf(continuation.brief.model));
	const handle = yield* ledger.start({ ...continuation, brief: { ...continuation.brief, model } });

	return { handle, substitution };
});

const delegateTool = (
	runtime: Runtime,
	roles: ReadonlyArray<ChildRole>,
	place: Omit<ChildSession, "id">,
	table: ModelTable,
	ownSession: Option.Option<OwnSession>,
) => {
	const parameters = delegateParams({ table, roles });

	return {
		name: "delegate",
		label: "delegate",
		description: "Start a delegate on one task. It wakes you with its answer.",
		promptGuidelines: [
			...delegateGuidelines,
			...(Arr.contains(roles, "owner") ? ownerGuidelines : [lastLevelGuideline]),
		],
		parameters,
		outputSchema: HandleOut,
		execute: (_id, call, signal, _update, ctx: Caller) =>
			runTool(runtime, signal)(
				(ledger) =>
					Effect.gen(function* () {
						if (call.continues !== undefined) {
							return yield* relaunched({ ledger, ctx, table, ref: call.continues, call });
						}

						const fresh = yield* freshCall(call);
						const inherited = yield* ownBrief(ownSession);
						const { brief, cwd, substitution } = yield* parseCall(ctx, table, roles, inherited, fresh);
						const reviewed = yield* withReview(fresh.reviews)(brief);

						const handle = yield* ledger.start(
							StartRequest.Delegate({
								brief: reviewed,
								childSession: { ...place, cwd: Option.getOrElse(cwd, () => place.cwd), id: uuidv7() },
								group: Option.fromUndefinedOr(call.group),
							}),
						);

						return { handle, substitution };
					}),
				Out.delegated,
			),
	} satisfies ToolDefinition<DelegateParams, JsonValue>;
};

const serveTool = (runtime: Runtime) =>
	({
		name: "serve",
		label: "serve",
		description:
			"Start a long-running command, such as a dev server. It runs until you cancel it, or until the group holding it settles. Its pane is the human's live view of the command.",
		promptGuidelines,
		parameters: ServeParams,
		outputSchema: HandleOut,
		execute: (_id, { name, command, ready }, signal) =>
			runTool(runtime, signal)(
				(ledger) => ledger.start(StartRequest.Serve({ name, command, ready: Option.fromUndefinedOr(ready) })),
				(handle) => Out.command({ handle, redirect: stdoutRedirectOf(command) }),
			),
	}) satisfies ToolDefinition<typeof ServeParams, JsonValue>;

/** A watch's log sits beside the delegate sessions of the session that started it, and stays as long as they do. */
const watchTool = (runtime: Runtime, place: Omit<ChildSession, "id">) =>
	({
		name: "watch",
		label: "watch",
		description:
			"Start a command that wakes you once it exits, with its exit code, last lines, and log path. Copy the log after the wake when you need it as evidence. Its pane is the human's live view of the command.",
		parameters: WatchParams,
		outputSchema: HandleOut,
		execute: (_id, { name, command, deadline }, signal) => {
			const after = Option.map(Option.fromUndefinedOr(deadline), Duration.seconds);
			const request = StartRequest.Watch({ name, command, deadline: after, log: `${place.dir}/${uuidv7()}.log` });

			return runTool(runtime, signal)(
				(ledger) => Effect.andThen(makeSessionFolder(place.dir), ledger.start(request)),
				(handle) => Out.command({ handle, redirect: stdoutRedirectOf(command) }),
			);
		},
	}) satisfies ToolDefinition<typeof WatchParams, JsonValue>;

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
	session: Pick<ExtensionContext["sessionManager"], "getSessionDir" | "getSessionId">,
) => {
	pi.registerTool(serveTool(runtime));
	pi.registerTool(watchTool(runtime, place));
	pi.registerTool(groupTool(runtime));
	pi.registerTool(cancelTool(runtime));

	const roles = childRoles(self);

	if (Arr.isReadonlyArrayNonEmpty(roles)) {
		const ownSession = Self.$is("Delegate")(self)
			? Option.some({ dir: session.getSessionDir(), id: session.getSessionId() })
			: Option.none();

		pi.registerTool(delegateTool(runtime, roles, place, modelTable, ownSession));
	}
};

export type ToolServices = Gh | BriefSources;

export const Tools = {
	register,
	delegate: delegateTool,
	serve: serveTool,
	watch: watchTool,
	layer: Layer.merge(ghLayer, briefSourcesLayer),
};
