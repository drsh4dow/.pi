import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** How much of one rate-limit window an account has used. */
export interface Window {
	readonly name: string;
	readonly percent: number;
	readonly resetsAt: Option.Option<DateTime.Utc>;
}

/** An amount in a currency's minor unit, such as 884857 with exponent 2 for $8,848.57. */
export interface Money {
	readonly minor: number;
	readonly exponent: number;
	readonly currency: string;
}

/** Extra usage: what the account spends past its plan limits this month, against its cap. */
export interface Spend {
	readonly used: Money;
	readonly cap: Option.Option<Money>;
	/** Why extra usage is off, such as `out_of_credits`. None while it is on. */
	readonly off: Option.Option<string>;
}

export interface PlanUsage {
	readonly windows: ReadonlyArray<Window>;
	readonly spend: Option.Option<Spend>;
}

export interface ProbeRequest {
	readonly token: Redacted.Redacted;
	readonly model: string;
}

export class ClaudeUsageError extends Schema.TaggedError<ClaudeUsageError, { readonly brand: unique symbol }>()(
	"ClaudeUsageError",
	{
		message: Schema.String,
	},
) {}

export class ClaudeUsage extends Context.Service<
	ClaudeUsage,
	{
		/** The account's usage page, which needs an OAuth token with the `user:profile` scope. */
		readonly plan: (token: Redacted.Redacted) => Effect.Effect<PlanUsage, ClaudeUsageError>;
		/**
		 * Sends a one-token message and reads the rate-limit headers on the reply, for a token without `user:profile`, such
		 * as one from `claude setup-token`. A rejected reply carries the headers too and costs nothing.
		 */
		readonly probe: (request: ProbeRequest) => Effect.Effect<ReadonlyArray<Window>, ClaudeUsageError>;
	}
>()("pi-harness/clients/claude-usage/ClaudeUsage") {}

const MoneyWire = Schema.Struct({ amount_minor: Schema.Finite, exponent: Schema.Int, currency: Schema.String });

const ScopeWire = Schema.Struct({ model: Schema.NullOr(Schema.Struct({ display_name: Schema.String })) });

const LimitWire = Schema.Struct({
	group: Schema.String,
	percent: Schema.Finite,
	resets_at: Schema.NullOr(Schema.String),
	scope: Schema.NullOr(ScopeWire),
});

const SpendWire = Schema.Struct({
	used: MoneyWire,
	limit: Schema.NullOr(MoneyWire),
	enabled: Schema.Boolean,
	disabled_reason: Schema.NullOr(Schema.String),
});

/** Only the fields `/usage` reads. The page carries many more, under code names that change without notice. */
const PlanWire = Schema.Struct({ limits: Schema.Array(LimitWire), spend: Schema.NullOr(SpendWire) });

const ErrorWire = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

type MoneyWire = typeof MoneyWire.Type;

type LimitWire = typeof LimitWire.Type;

type SpendWire = typeof SpendWire.Type;

type PlanWire = typeof PlanWire.Type;

const decodePlan = Schema.decodeEffect(Schema.fromJsonString(PlanWire));

const decodeError = Schema.decodeOption(Schema.fromJsonString(ErrorWire));

const moneyOf = ({ amount_minor, exponent, currency }: MoneyWire): Money => ({
	minor: amount_minor,
	exponent,
	currency,
});

const limitName = ({ group, scope }: LimitWire) => {
	const model = Option.fromNullishOr(scope?.model?.display_name);

	return Option.match(model, { onNone: () => group, onSome: (name) => `${group} · ${name}` });
};

const windowOfLimit = (limit: LimitWire): Window => ({
	name: limitName(limit),
	percent: limit.percent,
	resetsAt: Option.flatMap(Option.fromNullOr(limit.resets_at), DateTime.make),
});

const spendOf = (wire: SpendWire): Spend => ({
	used: moneyOf(wire.used),
	cap: Option.map(Option.fromNullOr(wire.limit), moneyOf),
	off: wire.enabled ? Option.none() : Option.some(wire.disabled_reason ?? "disabled"),
});

const planOf = ({ limits, spend }: PlanWire): PlanUsage => ({
	windows: Arr.map(limits, windowOfLimit),
	spend: Option.map(Option.fromNullOr(spend), spendOf),
});

/** The claims Anthropic names in its headers, such as `5h` and `7d`, in the words the usage page uses. */
const claimNames = new Map([
	["5h", "5-hour"],
	["7d", "weekly"],
	["overage", "extra usage"],
]);

const utilization = /^anthropic-ratelimit-unified-(?<claim>.+)-utilization$/u;

const HeadersWire = Schema.Record(Schema.String, Schema.String);

type HeadersWire = typeof HeadersWire.Type;

const decodeHeaders = HttpClientResponse.schemaHeaders(HeadersWire);

const resetOf = (headers: HeadersWire, claim: string) => {
	const seconds = Rec.get(headers, `anthropic-ratelimit-unified-${claim}-reset`);

	return Option.flatMap(seconds, (text) => DateTime.make(Number(text) * 1000));
};

const windowOfHeader = (headers: HeadersWire, [name, value]: readonly [string, string]): Option.Option<Window> =>
	Option.map(Option.fromUndefinedOr(utilization.exec(name)?.groups?.["claim"]), (claim) => ({
		name: claimNames.get(claim) ?? claim,
		percent: Number(value) * 100,
		resetsAt: resetOf(headers, claim),
	}));

/** Every unified rate-limit claim on a reply, from headers such as `anthropic-ratelimit-unified-7d-utilization: 1.0`. */
const windowsOf = (headers: HeadersWire): ReadonlyArray<Window> =>
	Arr.getSomes(Arr.map(Rec.toEntries(headers), (entry) => windowOfHeader(headers, entry)));

const oauthBeta = "oauth-2025-04-20";

/** Anthropic serves a subscription token only to a request that calls itself Claude Code. */
const claudeCodeSystem = "You are Claude Code, Anthropic's official CLI for Claude.";

const failure = (what: string) => (cause: unknown) => ClaudeUsageError.make({ message: `${what}: ${String(cause)}` });

/** The API's own error message for a non-2xx reply, such as a missing OAuth scope. */
const refusalOf = (what: string, response: HttpClientResponse.HttpClientResponse) =>
	Effect.flatMap(
		Effect.orElseSucceed(response.text, () => ""),
		(body) => {
			const said = Option.match(decodeError(body), {
				onNone: () => "",
				onSome: ({ error }) => `: ${error.message}`,
			});

			return Effect.fail(ClaudeUsageError.make({ message: `${what} answered HTTP ${response.status}${said}` }));
		},
	);

const usagePage = "Claude usage page";

const planBody = (response: HttpClientResponse.HttpClientResponse) =>
	response.status === 200 ? Effect.mapError(response.text, failure(usagePage)) : refusalOf(usagePage, response);

const probeWindows = (response: HttpClientResponse.HttpClientResponse) =>
	Effect.flatMap(Effect.mapError(decodeHeaders(response), failure("Claude probe")), (headers) => {
		const windows = windowsOf(headers);

		return Arr.isReadonlyArrayNonEmpty(windows) ? Effect.succeed(windows) : refusalOf("Claude probe", response);
	});

const probeBody = (model: string) => ({
	model,
	max_tokens: 1,
	system: claudeCodeSystem,
	messages: [{ role: "user", content: "hi" }],
});

const make = Effect.map(HttpClient.HttpClient, (http) =>
	ClaudeUsage.of({
		plan: (token) =>
			HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage").pipe(
				HttpClientRequest.bearerToken(Redacted.value(token)),
				HttpClientRequest.setHeader("anthropic-beta", oauthBeta),
				http.execute,
				Effect.mapError(failure(usagePage)),
				Effect.flatMap(planBody),
				Effect.flatMap((body) => Effect.mapError(decodePlan(body), failure(usagePage))),
				Effect.map(planOf),
			),
		probe: ({ token, model }) =>
			HttpClientRequest.post("https://api.anthropic.com/v1/messages").pipe(
				HttpClientRequest.bearerToken(Redacted.value(token)),
				HttpClientRequest.setHeaders({ "anthropic-beta": oauthBeta, "anthropic-version": "2023-06-01" }),
				HttpClientRequest.bodyJsonUnsafe(probeBody(model)),
				http.execute,
				Effect.mapError(failure("Claude probe")),
				Effect.flatMap(probeWindows),
			),
	}),
);

export const claudeUsageLayer: Layer.Layer<ClaudeUsage, never, HttpClient.HttpClient> = Layer.effect(ClaudeUsage, make);
