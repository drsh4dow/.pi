import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** How much of one OpenCode Go window the subscription has used. */
export interface Window {
	readonly name: string;
	readonly percent: number;
	readonly resetsAt: Option.Option<DateTime.Utc>;
}

export class OpencodeGoError extends Schema.TaggedError<OpencodeGoError, { readonly brand: unique symbol }>()(
	"OpencodeGoError",
	{
		message: Schema.String,
	},
) {}

export class OpencodeGo extends Context.Service<
	OpencodeGo,
	{
		readonly usage: (key: Redacted.Redacted) => Effect.Effect<ReadonlyArray<Window>, OpencodeGoError>;
	}
>()("pi-harness/clients/opencode-go/OpencodeGo") {}

const WindowWire = Schema.Struct({ percent: Schema.Finite, resetsAt: Schema.String });

/** A plan without a window, such as one with no monthly limit, leaves it out. */
const UsageWire = Schema.Struct({
	usage: Schema.Struct({
		rolling: Schema.optionalKey(WindowWire),
		weekly: Schema.optionalKey(WindowWire),
		monthly: Schema.optionalKey(WindowWire),
	}),
});

type UsageWire = typeof UsageWire.Type;

type WindowWire = typeof WindowWire.Type;

const windowOf = (name: string, wire: WindowWire | undefined) =>
	Option.map(Option.fromUndefinedOr(wire), ({ percent, resetsAt }) => ({
		name,
		percent,
		resetsAt: DateTime.make(resetsAt),
	}));

const windowsOf = ({ usage }: UsageWire): ReadonlyArray<Window> =>
	Arr.getSomes([
		windowOf("5-hour", usage.rolling),
		windowOf("weekly", usage.weekly),
		windowOf("monthly", usage.monthly),
	]);

const decodeUsage = Schema.decodeEffect(Schema.fromJsonString(UsageWire));

const failed = (cause: unknown) => OpencodeGoError.make({ message: `OpenCode Go usage: ${String(cause)}` });

/** The route has answered `503 Go usage is unavailable` for a moment and then served again. */
const resilient = (http: HttpClient.HttpClient) =>
	http.pipe(
		HttpClient.filterStatusOk,
		HttpClient.retryTransient({
			retryOn: "errors-and-responses",
			times: 2,
			schedule: Schedule.exponential("500 millis"),
		}),
	);

const make = Effect.map(HttpClient.HttpClient, (http) => {
	const client = resilient(http);

	return OpencodeGo.of({
		usage: (key) =>
			HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
				HttpClientRequest.bearerToken(Redacted.value(key)),
				client.execute,
				Effect.flatMap((response) => response.text),
				Effect.flatMap(decodeUsage),
				Effect.mapBoth({ onFailure: failed, onSuccess: windowsOf }),
			),
	});
});

export const opencodeGoLayer: Layer.Layer<OpencodeGo, never, HttpClient.HttpClient> = Layer.effect(OpencodeGo, make);
