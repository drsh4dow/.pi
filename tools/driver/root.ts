/**
 * The root pi in RPC mode. Owns the protocol: JSONL framing on LF only, command ids and responses, the settle rule, and
 * shutdown. Nothing of the wire leaves this file; the scenario sees `Root`.
 */
import * as Arr from "effect/Array";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { ScenarioFailed, SetupFailed } from "./failed.ts";
import type { World } from "./world.ts";

/** The root pi a scenario talks to. Every call fails at once if the root has exited. */
export interface Root {
	/**
	 * Sends `message` and waits for the `agent_settled` that follows pi's answer to it: no retry, compaction or queued
	 * message left. Returns the root's last assistant text, or none (an extension command handled it, or the run ended on
	 * an error). Sent as a follow-up, so a prompt while a wake turn runs queues behind it instead of failing.
	 * Fails when pi rejects the prompt or `within` (default 10 minutes) passes first.
	 */
	readonly prompt: (message: string, within?: Duration.Input) => Effect.Effect<Option.Option<string>, ScenarioFailed>;
	/** The root pi's stderr so far. */
	readonly output: Effect.Effect<string>;
}

/** The root as the driver holds it: the scenario's `Root` plus what only the driver reads. */
export interface RootProcess extends Root {
	/** From `get_state` at start. pi creates the file at the first message, so it can be missing early on. */
	readonly session: { readonly id: string; readonly file: string };
	/** Fails with `the root pi exited <code>` once the root exits, for any reason. Race any wait against it. */
	readonly exited: Effect.Effect<never, ScenarioFailed>;
}

/** The commands the driver sends. One list, so the protocol the driver depends on is visible in one place. */
type Command =
	| { readonly type: "get_state" }
	| { readonly type: "prompt"; readonly message: string; readonly streamingBehavior: "followUp" }
	| { readonly type: "get_last_assistant_text" };

const Response = Schema.Struct({
	type: Schema.Literal("response"),
	id: Schema.optionalKey(Schema.String),
	success: Schema.Boolean,
	data: Schema.optionalKey(Schema.Unknown),
	error: Schema.optionalKey(Schema.String),
});

/** The stdout records the driver acts on. Every other record is only logged to `root.out.jsonl`. */
const Inbound = Schema.Union([Response, Schema.Struct({ type: Schema.Literal("agent_settled") })]);

type Inbound = typeof Inbound.Type;

const decodeInbound = Schema.decodeUnknownOption(Schema.fromJsonString(Inbound));

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const isResponseTo =
	(id: string) =>
	(record: Inbound): record is typeof Response.Type =>
		record.type === "response" && record.id === id;

const isSettled = (record: Inbound) => record.type === "agent_settled";

const failed = (message: string) => Effect.fail(ScenarioFailed.make({ message }));

/**
 * Pure. Splits on LF only, dropping one CR before it. Unicode line and paragraph separators are valid inside JSON
 * strings, so a generic line splitter would cut records apart (pi's docs/rpc.md, Framing).
 */
export const lfLines = ({ carried, chunk }: { readonly carried: string; readonly chunk: string }) => {
	const parts = Str.split(`${carried}${chunk}`, "\n");
	const complete = Arr.dropRight(parts, 1);

	return {
		lines: Arr.map(complete, (line) => (Str.endsWith("\r")(line) ? Str.slice(0, -1)(line) : line)),
		rest: Arr.lastNonEmpty(parts),
	};
};

/** As text, each chunk appended to `log` as it arrives. */
const logged = <Failure>(fs: FileSystem.FileSystem, bytes: Stream.Stream<Uint8Array, Failure>, log: string) =>
	bytes.pipe(
		Stream.tap((chunk) => fs.writeFile(log, chunk, { flag: "a" })),
		Stream.decodeText,
	);

const recordsIn = <Failure>(text: Stream.Stream<string, Failure>) =>
	Stream.mapAccum(
		text,
		() => "",
		(carried, chunk) => {
			const { lines, rest } = lfLines({ carried, chunk });

			return [rest, Arr.getSomes(Arr.map(lines, (line) => decodeInbound(line)))];
		},
	);

/** The running root's channels: records from stdout, its stderr so far, and a way to send a command. */
interface Wire {
	readonly records: PubSub.PubSub<Inbound>;
	readonly stderr: Effect.Effect<string>;
	readonly exited: Effect.Effect<never, ScenarioFailed>;
	/** Writes the command with a fresh id to stdin and `root.in.jsonl`, and returns the id. */
	readonly send: (command: Command) => Effect.Effect<string>;
}

type Needs = Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

interface Channels {
	readonly input: Queue.Queue<string, Cause.Done>;
	readonly records: PubSub.PubSub<Inbound>;
	readonly ended: Deferred.Deferred<number>;
}

/**
 * Spawns the root through the `bin/pi` wrapper and feeds stdout records to `records`, stderr to its log, and the exit
 * code to `ended`. The scope ends stdin, waits a minute for pi to exit, then signals the process group.
 */
const spawned = Effect.fn("spawned")(function* ({
	world: { layout, env },
	model,
	channels,
}: {
	readonly world: World;
	readonly model: string;
	readonly channels: Channels;
}) {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const stdin = Stream.encodeText(Stream.fromQueue(channels.input));
	const args = ["--mode", "rpc", "--model", model, "--session-dir", layout.sessions];

	const handle = yield* spawner.spawn(
		ChildProcess.make(`${layout.bin}/pi`, args, { cwd: layout.project, env, stdin, forceKillAfter: "10 seconds" }),
	);

	const records = recordsIn(logged(fs, handle.stdout, layout.rpcOut));

	yield* Effect.forkScoped(Stream.runForEach(records, (record) => PubSub.publish(channels.records, record)));
	yield* Effect.forkScoped(Stream.run(handle.stderr, fs.sink(layout.rootStderr)));
	yield* handle.exitCode.pipe(
		Effect.orElseSucceed(() => -1),
		Effect.flatMap((code) => Deferred.succeed(channels.ended, code)),
		Effect.forkScoped,
	);
	yield* Effect.addFinalizer(() =>
		Queue.end(channels.input).pipe(
			Effect.andThen(Deferred.await(channels.ended)),
			Effect.timeout("60 seconds"),
			Effect.ignore,
		),
	);
});

const openWire = Effect.fn("openWire")(function* (root: { readonly world: World; readonly model: string }) {
	const fs = yield* FileSystem.FileSystem;
	const { layout } = root.world;
	const ids = yield* Ref.make(0);

	const channels = yield* Effect.all({
		input: Queue.unbounded<string, Cause.Done>(),
		records: PubSub.unbounded<Inbound>(),
		ended: Deferred.make<number>(),
	});

	yield* spawned({ ...root, channels });

	const send = Effect.fn("send")(function* (command: Command) {
		const count = yield* Ref.updateAndGet(ids, (next) => next + 1);
		const id = `c${String(count)}`;
		const json = yield* Effect.orDie(encodeCommand({ id, ...command }));

		yield* Effect.orDie(fs.writeFileString(layout.rpcIn, `${json}\n`, { flag: "a" }));
		yield* Queue.offer(channels.input, `${json}\n`);

		return id;
	});

	return {
		records: channels.records,
		stderr: Effect.orElseSucceed(fs.readFileString(layout.rootStderr), () => ""),
		exited: Effect.flatMap(Deferred.await(channels.ended), (code) =>
			failed(`the root pi exited ${String(code)}, see ${layout.rootStderr}`),
		),
		send,
	} satisfies Wire;
});

/** Sends `command` and returns the data of pi's response. Subscribe before, to also see what follows the response. */
const request = Effect.fn("request")(function* (
	wire: Wire,
	subscription: PubSub.Subscription<Inbound>,
	command: Command,
) {
	const id = yield* wire.send(command);
	const answer = PubSub.take(subscription).pipe(Effect.repeat({ until: isResponseTo(id) }));
	const response = yield* Effect.raceFirst(answer, wire.exited);

	if (!response.success) {
		return yield* ScenarioFailed.make({
			message: `pi rejected ${command.type}: ${response.error ?? "no reason given"}`,
		});
	}

	return response.data;
});

/** `request`, its data decoded with `schema`. */
const asked = <Value>(wire: Wire, command: Command, schema: Schema.Decoder<Value>) =>
	PubSub.subscribe(wire.records).pipe(
		Effect.flatMap((subscription) => request(wire, subscription, command)),
		Effect.scoped,
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.catchTag("SchemaError", (error) => failed(`pi answered ${command.type} unexpectedly: ${error.message}`)),
	);

const decodeDisposition = Schema.decodeUnknownEffect(Schema.Struct({ disposition: Schema.String }));

const LastText = Schema.Struct({ text: Schema.NullOr(Schema.String) });

/** `within` bounds the whole prompt: pi's acknowledgement, the settle, and the final text. */
const prompted =
	(wire: Wire, progress: (what: string) => Effect.Effect<void>) =>
	(message: string, within: Duration.Input = "10 minutes") =>
		Effect.gen(function* () {
			const subscription = yield* PubSub.subscribe(wire.records);
			const data = yield* request(wire, subscription, { type: "prompt", message, streamingBehavior: "followUp" });
			const { disposition } = yield* decodeDisposition(data);

			if (disposition === "handled") {
				return Option.none<string>();
			}

			yield* Effect.raceFirst(PubSub.take(subscription).pipe(Effect.repeat({ until: isSettled })), wire.exited);

			const { text } = yield* asked(wire, { type: "get_last_assistant_text" }, LastText);

			yield* progress("prompt settled");

			return Option.fromNullOr(text);
		}).pipe(
			Effect.scoped,
			Effect.catchTag("SchemaError", (error) => failed(`pi answered the prompt unexpectedly: ${error.message}`)),
			Effect.timeoutOrElse({
				duration: within,
				orElse: () =>
					failed(`the root did not settle within ${String(Duration.toSeconds(within))} s after "${message}"`),
			}),
		);

const State = Schema.Struct({ sessionId: Schema.String, sessionFile: Schema.String });

/** Starts the root and returns once it answered `get_state`. */
export const startRoot = (input: {
	readonly world: World;
	readonly model: string;
	readonly progress: (what: string) => Effect.Effect<void>;
}): Effect.Effect<RootProcess, SetupFailed, Needs> =>
	Effect.gen(function* () {
		const wire = yield* openWire(input);

		const state = yield* asked(wire, { type: "get_state" }, State).pipe(
			Effect.timeoutOrElse({
				duration: "60 seconds",
				orElse: () => failed("no answer to get_state within 60 seconds"),
			}),
			Effect.catchTag("ScenarioFailed", ({ message }) =>
				Effect.fail(SetupFailed.make({ message: `pi did not start: ${message}` })),
			),
		);

		return {
			prompt: prompted(wire, input.progress),
			output: wire.stderr,
			session: { id: state.sessionId, file: state.sessionFile },
			exited: wire.exited,
		};
	}).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(SetupFailed.make({ message: error.message }))));
