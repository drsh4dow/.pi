import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type Static, Type } from "typebox";

export const Turn = Schema.Struct({
	role: Schema.Literals(["user", "assistant"]),
	text: Schema.String,
});

export type Turn = typeof Turn.Type;

const SummarizeParams = Type.Object({ path: Type.String({ description: "File to summarize" }) });

type SummarizeParams = Static<typeof SummarizeParams>;

type Event = Data.TaggedEnum<{
	Started: { readonly id: string };
	Stopped: { readonly id: string; readonly reason: string };
}>;

export const Event = Data.taggedEnum<Event>();

class ReadFailed extends Schema.TaggedError<ReadFailed, { readonly brand: unique symbol }>()("ReadFailed", {
	path: Schema.String,
}) {}

class Files extends Context.Service<
	Files,
	{
		readonly read: (path: string) => Effect.Effect<string, ReadFailed>;
	}
>()("pi-harness/tools/oxlint/fixtures/effect-pi-idioms/Files") {}

const FilesLive = Layer.succeed(Files, {
	read: (path) =>
		Str.isNonEmpty(path) ? Effect.succeed(`contents of ${path}`) : Effect.fail(ReadFailed.make({ path })),
});

const describe = Match.type<Event>().pipe(
	Match.tag("Started", (event) => `started ${event.id}`),
	Match.tag("Stopped", (event) => `stopped ${event.id}: ${event.reason}`),
	Match.exhaustive,
);

const lastUserTurn = (turns: ReadonlyArray<Turn>) =>
	Arr.findLast(turns, (turn) => turn.role === "user").pipe(Option.map((turn) => turn.text));

const summarize = Effect.fn("summarize")(function* (path: string) {
	const files = yield* Files;
	const text = yield* files.read(path);
	const turns = yield* Effect.forEach([text], (line) => Effect.succeed<Turn>({ role: "user", text: line }));

	return Str.toUpperCase(Option.getOrElse(lastUserTurn(turns), () => describe(Event.Started({ id: path }))));
});

const toolResult = ({ path }: SummarizeParams) =>
	summarize(path).pipe(
		Effect.retry(Schedule.recurs(3)),
		Effect.tapError((error) => Effect.logWarning(error._tag)),
		Effect.catchTag("ReadFailed", (error) => Effect.succeed(`missing ${error.path}`)),
		Effect.map((text) => ({ content: [{ type: "text" as const, text }], details: {} })),
	);

export default function (pi: ExtensionAPI) {
	const runtime = ManagedRuntime.make(FilesLive);

	pi.on("session_shutdown", () => runtime.dispose());
	pi.registerTool({
		name: "summarize",
		label: "Summarize",
		description: "Summarize a file",
		parameters: SummarizeParams,
		execute: (_toolCallId, params, signal, _onUpdate, _ctx) => runtime.runPromise(toolResult(params), { signal }),
	});
}
