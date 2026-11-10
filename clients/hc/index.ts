import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Arr from "effect/Array";
import * as Brand from "effect/Brand";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { nameAt, type TerminalName } from "./name.ts";

export type TerminalAddress = string & Brand.Brand<"TerminalAddress">;

export const TerminalAddress = Brand.nominal<TerminalAddress>();

export { type TerminalName, terminalNameOf } from "./name.ts";

export type TerminalEnd = Data.TaggedEnum<{
	Exited: { readonly code: Option.Option<number>; readonly signal: Option.Option<number> };
	Lost: { readonly reason: string };
}>;

export const TerminalEnd = Data.taggedEnum<TerminalEnd>();

export interface TerminalSnapshot {
	readonly terminal: TerminalAddress;
	readonly ref: string;
	readonly end: Option.Option<TerminalEnd>;
}

export type HcNotice = Data.TaggedEnum<{
	Ended: { readonly terminal: TerminalAddress; readonly end: TerminalEnd };
	/** `subscribedAt` is `Clock.monotonicTimeNanos` when the subscription that saw `terminals` began. */
	Resynced: { readonly terminals: ReadonlyArray<TerminalSnapshot>; readonly subscribedAt: bigint };
}>;

export const HcNotice = Data.taggedEnum<HcNotice>();

export interface RunSpec {
	readonly ref: string;
	/** Shown in Herdr's agents list and taken by `hc attach`. A live terminal holding it already gets `-2`, `-3`, and so on. */
	readonly name: TerminalName;
	/** Set beside the ones hc itself uses to find the terminal again. */
	readonly labels: Readonly<Record<string, string>>;
	readonly argv: readonly [string, ...Array<string>];
	readonly cwd: string;
	/** Layered on the hc core's env, not this process's, so it names everything the program needs. */
	readonly env: Readonly<Record<string, string>>;
}

export class HcError extends Schema.TaggedError<HcError, { readonly brand: unique symbol }>()("HcError", {
	method: Schema.String,
	kind: Schema.String,
	message: Schema.String,
}) {}

export class Hc extends Context.Service<
	Hc,
	{
		readonly run: (spec: RunSpec) => Effect.Effect<TerminalAddress, HcError>;
		readonly kill: (terminal: TerminalAddress) => Effect.Effect<void>;
		readonly label: (terminal: TerminalAddress, labels: Readonly<Record<string, string>>) => Effect.Effect<void>;
		readonly waitForOutput: (
			terminal: TerminalAddress,
			pattern: string,
			timeout: Duration.Duration,
		) => Effect.Effect<boolean, HcError>;
		readonly tail: (terminal: TerminalAddress, lines: number) => Effect.Effect<string, HcError>;
		readonly notices: Stream.Stream<HcNotice>;
	}
>()("pi-harness/clients/hc/Hc") {}

export interface HcOptions {
	readonly agentKey: string;
	/** The terminal pi runs in, so its work shows under it. */
	readonly parent: Option.Option<TerminalAddress>;
}

const Labels = Schema.Record(Schema.String, Schema.String);
const Code = Schema.OptionFromNullOr(Schema.Int);
const WireEnd = Schema.Struct({ reason: Schema.NullOr(Schema.String), exit_code: Code, signal: Code });
const WireTerminal = Schema.Struct({ ...WireEnd.fields, address: Schema.String, state: Schema.String, labels: Labels });
const Terminals = Schema.Struct({ terminals: Schema.Array(WireTerminal) });
const Address = Schema.Struct({ address: Schema.String });
const Kind = Schema.Struct({ kind: Schema.String });
const Failure = Schema.Struct({ message: Schema.String, data: Schema.optionalKey(Kind) });
const Request = Schema.fromJsonString(Schema.Struct({ id: Schema.Int, method: Schema.String, params: Schema.Json }));
const EndEvent = Schema.Struct({ type: Schema.Literals(["finished", "lost"]), terminal: Schema.String, data: WireEnd });

const Inbound = Schema.Union([
	Schema.Struct({ error: Failure }),
	Schema.Struct({ result: Terminals }),
	Schema.Struct({ method: Schema.Literal("missed"), params: Terminals }),
	Schema.Struct({ method: Schema.Literal("event"), params: EndEvent }),
	Schema.Struct({ method: Schema.Literals(["event", "heartbeat"]) }),
]);

const lostReasons: ReadonlySet<string> = new Set(["holder_lost", "stopped_by_restart"]);

const endOf = (lost: boolean, end: typeof WireEnd.Type): TerminalEnd =>
	lost || lostReasons.has(end.reason ?? "")
		? TerminalEnd.Lost({ reason: end.reason ?? "lost" })
		: TerminalEnd.Exited({ code: end.exit_code, signal: end.signal });

const resynced = (subscribedAt: bigint, { terminals }: typeof Terminals.Type) =>
	HcNotice.Resynced({
		subscribedAt,
		terminals: Arr.map(terminals, (wire) => ({
			terminal: TerminalAddress(wire.address),
			ref: wire.labels["ow.ref"] ?? "",
			end: wire.state === "finished" ? Option.some(endOf(false, wire)) : Option.none(),
		})),
	});

const ended = ({ terminal, type, data }: typeof EndEvent.Type) =>
	HcNotice.Ended({ terminal: TerminalAddress(terminal), end: endOf(type === "lost", data) });

const rpcError = (method: string, { message, data }: typeof Failure.Type) =>
	HcError.make({ method, kind: data?.kind ?? "rpc", message });

const transient = (error: HcError) => error.kind === "closed" || error.kind === "socket";
const notFound = (error: HcError) => error.kind === "not_found";
const closed = (method: string) => HcError.make({ method, kind: "closed", message: "the hc socket closed" });
const retrying = Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("5 seconds")]);
const safely = { while: transient, times: 10, schedule: retrying };

/** The write side stays open, because hc ends a subscription when the client half-closes. */
const exchange = (socket: string, request: string) =>
	Effect.map(NodeSocket.makeNet({ path: socket }), (conn) =>
		Stream.pipeThroughChannel(
			Stream.concat(Stream.make(`${request}\n`), Stream.never),
			Socket.toChannelString<never>(conn),
		),
	);

const lines = <Out>(socket: string, method: string, params: Schema.Json, schema: Schema.Decoder<Out>) =>
	Schema.encodeEffect(Request)({ id: 1, method, params }).pipe(
		Effect.orDie,
		Effect.flatMap((request) => exchange(socket, request)),
		Stream.unwrap,
		Stream.catchReason("SocketError", "SocketCloseError", (reason, error) =>
			reason.code === 1000 ? Stream.empty : Stream.fail(error),
		),
		Stream.mapError((error) => HcError.make({ method, kind: "socket", message: error.message })),
		Stream.splitLines,
		Stream.mapEffect((line) =>
			Schema.decodeEffect(Schema.fromJsonString(schema))(line).pipe(
				Effect.mapError((error) => HcError.make({ method, kind: "decode", message: error.message })),
			),
		),
	);

const call = <Out>(socket: string, method: string, params: Schema.Json, result: Schema.Decoder<Out>) =>
	lines(socket, method, params, Schema.Union([Schema.Struct({ result }), Schema.Struct({ error: Failure })])).pipe(
		Stream.runHead,
		Effect.flatMap(Effect.fromOption(() => closed(method))),
		Effect.flatMap((it) => ("error" in it ? Effect.fail(rpcError(method, it.error)) : Effect.succeed(it.result))),
	);

const maxNameAttempts = 20;

type RunParams = Omit<RunSpec, "ref"> & { readonly parent: string | null };

const runNamed = (socket: string, params: RunParams, attempt: number): Effect.Effect<typeof Address.Type, HcError> =>
	call(socket, "terminal.run", { ...params, name: nameAt(attempt)(params.name), no_notify: true }, Address).pipe(
		Effect.catchIf(
			(error) => error.kind === "name_taken" && attempt < maxNameAttempts,
			() => runNamed(socket, params, attempt + 1),
		),
	);

/** `own` finds a terminal an earlier try already started, so a retry never starts a second one. */
const start = (socket: string, own: typeof Labels.Type, params: RunParams) =>
	call(socket, "terminal.list", { all: true, labels: own }, Terminals).pipe(
		Effect.flatMap(({ terminals: [found] }) =>
			found === undefined ? runNamed(socket, params, 1) : Effect.succeed(found),
		),
		Effect.retry({ ...safely, while: (error) => transient(error) || error.kind === "spawn_failed" }),
		Effect.map(({ address }) => TerminalAddress(address)),
	);

/** A change to a terminal that may already be gone, which is then nothing left to do. */
const change = (socket: string, method: string, params: Schema.JsonObject & { readonly terminal: TerminalAddress }) =>
	call(socket, method, params, Address).pipe(
		Effect.retry(safely),
		Effect.catchIf(notFound, () => Effect.void),
		Effect.ignore({ log: "Warn" }),
	);

const read = (socket: string, terminal: TerminalAddress, history: number) =>
	call(socket, "terminal.read", { terminal, lines: history }, Schema.Struct({ text: Schema.String })).pipe(
		Effect.retry(safely),
		Effect.map(({ text }) => Str.trimEnd(text)),
	);

/** Checks what is already printed, then waits, then reads once more after a miss, so no print slips between. */
const waitForOutput = (socket: string, terminal: TerminalAddress, pattern: string, timeout: Duration.Duration) => {
	const printed = Effect.map(read(socket, terminal, 1000), Str.includes(pattern));
	const params = { terminal, output: pattern, timeout: Duration.toSeconds(timeout) };

	const wait = call(socket, "terminal.wait", params, Schema.Struct({ reason: Schema.String })).pipe(
		Effect.retry(safely),
		Effect.flatMap(({ reason }) => (reason === "output" ? Effect.succeed(true) : printed)),
	);

	return Effect.filterOrElse(printed, Boolean, () => wait);
};

const makeFeed = Effect.all({ notices: Queue.unbounded<HcNotice>(), subscribed: Latch.make() });

type Feed = Effect.Success<typeof makeFeed>;

const handle = (feed: Feed, subscribedAt: bigint) =>
	Match.type<typeof Inbound.Type>().pipe(
		Match.when({ error: Match.defined }, ({ error }) => Effect.fail(rpcError("events.subscribe", error))),
		Match.when({ result: Match.defined }, ({ result }) =>
			Effect.andThen(feed.subscribed.open, Queue.offer(feed.notices, resynced(subscribedAt, result))),
		),
		Match.when({ method: "missed" }, ({ params }) => Queue.offer(feed.notices, resynced(subscribedAt, params))),
		Match.when({ params: Match.defined }, ({ params }) => Queue.offer(feed.notices, ended(params))),
		Match.orElse(() => Effect.void),
	);

const follow = (socket: string, own: typeof Labels.Type, feed: Feed) =>
	Clock.monotonicTimeNanos.pipe(
		Effect.flatMap((subscribedAt) =>
			lines(socket, "events.subscribe", { labels: own }, Inbound).pipe(
				Stream.tap(handle(feed, subscribedAt)),
				Stream.runCount,
			),
		),
		Effect.filterOrFail(Boolean, () => closed("events.subscribe")),
		Effect.retry(retrying),
		Effect.forever,
	);

const socketOf = ({ HC_TERMINAL_SOCKET, XDG_RUNTIME_DIR = "/tmp", HC_SESSION = "default" }: NodeJS.ProcessEnv) =>
	HC_TERMINAL_SOCKET ?? `${XDG_RUNTIME_DIR}/herdr-core/${HC_SESSION}.sock`;

const lastLines = (count: number) => (text: string) => Arr.join(Arr.takeRight(Str.split(text, "\n"), count), "\n");

const notSubscribed = HcError.make({
	method: "events.subscribe",
	kind: "timeout",
	message: "no subscription after 10 s",
});

/**
 * One subscription by the `ow.agent` label sees every end. The agent's own terminal parents each one, so Herdr shows
 * them under it, and hc ends them when a delegate's pi exits. A root's slice ends them when the root dies.
 */
export const hcLayer = (options: HcOptions): Layer.Layer<Hc> =>
	Layer.effect(
		Hc,
		Effect.gen(function* () {
			const socket = socketOf(process.env);
			const feed = yield* makeFeed;
			const scope = yield* Effect.scope;
			const agent = { "ow.agent": options.agentKey };
			const subscription = yield* Effect.cached(Effect.forkIn(follow(socket, agent, feed), scope));
			const parent = Option.getOrNull(options.parent);

			return Hc.of({
				run: Effect.fn("Hc.run")(function* ({ ref, name, labels, argv: program, cwd, env }) {
					const own = { ...agent, "ow.ref": ref };

					yield* subscription;
					yield* Effect.mapError(Effect.timeout(feed.subscribed.await, "10 seconds"), () => notSubscribed);

					return yield* start(socket, own, {
						argv: program,
						cwd,
						env,
						parent,
						name,
						labels: { ...labels, ...own },
					});
				}),
				kill: (terminal) => change(socket, "terminal.kill", { terminal }),
				label: (terminal, labels) => change(socket, "terminal.label", { terminal, labels }),
				waitForOutput: (terminal, pattern, timeout) => waitForOutput(socket, terminal, pattern, timeout),
				tail: (terminal, count) => Effect.map(read(socket, terminal, count), lastLines(count)),
				notices: Stream.fromQueue(feed.notices),
			});
		}),
	);
