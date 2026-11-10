import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

export class HcError extends Schema.TaggedError<HcError, { readonly brand: unique symbol }>()("HcError", {
	method: Schema.String,
	kind: Schema.String,
	message: Schema.String,
}) {}

const Kind = Schema.Struct({ kind: Schema.String });
export const Failure = Schema.Struct({ message: Schema.String, data: Schema.optionalKey(Kind) });
const Request = Schema.fromJsonString(Schema.Struct({ id: Schema.Int, method: Schema.String, params: Schema.Json }));

export const rpcError =
	(method: string) =>
	({ message, data }: typeof Failure.Type) =>
		HcError.make({ method, kind: data?.kind ?? "rpc", message });

export const transient = (error: HcError) => error.kind === "closed" || error.kind === "socket";
export const closed = (method: string) => HcError.make({ method, kind: "closed", message: "the hc socket closed" });
export const retrying = Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("5 seconds")]);
export const safely = { while: transient, times: 10, schedule: retrying };

/** The write side stays open, because hc ends a subscription when the client half-closes. */
const exchange = (socket: string, request: string) =>
	Effect.map(NodeSocket.makeNet({ path: socket }), (conn) =>
		Stream.pipeThroughChannel(
			Stream.concat(Stream.make(`${request}\n`), Stream.never),
			Socket.toChannelString<never>(conn),
		),
	);

export const lines =
	(socket: string) =>
	<Out>(method: string, params: Schema.Json, schema: Schema.Decoder<Out>) =>
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

export const call =
	(socket: string) =>
	<Out>(method: string, params: Schema.Json, result: Schema.Decoder<Out>) =>
		lines(socket)(method, params, Schema.Union([Schema.Struct({ result }), Schema.Struct({ error: Failure })])).pipe(
			Stream.runHead,
			Effect.flatMap(Effect.fromOption(() => closed(method))),
			Effect.flatMap((it) => ("error" in it ? Effect.fail(rpcError(method)(it.error)) : Effect.succeed(it.result))),
		);
