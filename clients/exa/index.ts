import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export const Limit = Schema.Int.pipe(
	Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
	Schema.brand("Limit"),
);

export type Limit = typeof Limit.Type;

export interface SearchRequest {
	readonly query: string;
	readonly limit: Limit;
	readonly domains: ReadonlyArray<string>;
	readonly since: Option.Option<string>;
}

export interface Hit {
	readonly title: string;
	readonly url: string;
	readonly published: Option.Option<string>;
	readonly highlights: ReadonlyArray<string>;
}

export interface Hits {
	readonly hits: ReadonlyArray<Hit>;
	readonly costUsd: Option.Option<number>;
}

export interface Content {
	readonly title: Option.Option<string>;
	readonly text: string;
}

export class ExaError extends Schema.TaggedError<ExaError, { readonly brand: unique symbol }>()("ExaError", {
	message: Schema.String,
}) {}

export class Exa extends Context.Service<
	Exa,
	{
		readonly hasKey: boolean;
		readonly search: (request: SearchRequest) => Effect.Effect<Hits, ExaError>;
		readonly contents: (url: string) => Effect.Effect<Option.Option<Content>, ExaError>;
	}
>()("pi-harness/clients/exa/Exa") {}

const Result = Schema.Struct({
	title: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
	url: Schema.String,
	publishedDate: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
	highlights: Schema.String.pipe(Schema.Array, Schema.optionalKey),
	text: Schema.optionalKey(Schema.String),
});

const Answer = Schema.Struct({
	results: Schema.Array(Result),
	costDollars: Schema.optionalKey(Schema.Struct({ total: Schema.Finite })),
});

type Result = typeof Result.Type;

type Answer = typeof Answer.Type;

interface SearchBody {
	readonly query: string;
	readonly type: "auto";
	readonly numResults: number;
	readonly includeDomains: ReadonlyArray<string> | undefined;
	readonly startPublishedDate: string | undefined;
	readonly contents: { readonly highlights: true };
}

/** `maxAgeHours: 1` makes Exa re-crawl any page it cached over an hour ago, so a stale copy is not served as current. */
interface ContentsBody {
	readonly urls: readonly [string];
	readonly text: true;
	readonly maxAgeHours: 1;
	readonly livecrawlTimeout: number;
}

const searchBody = ({ query, limit, domains, since }: SearchRequest): SearchBody => ({
	query,
	type: "auto",
	numResults: limit,
	includeDomains: Arr.isReadonlyArrayNonEmpty(domains) ? domains : undefined,
	startPublishedDate: Option.getOrUndefined(since),
	contents: { highlights: true },
});

const titleOf = (result: Result) => Option.filter(Option.fromNullishOr(result.title), Str.isNonEmpty);

const hitOf = (result: Result): Hit => ({
	title: Option.getOrElse(titleOf(result), () => result.url),
	url: result.url,
	published: Option.map(Option.fromNullishOr(result.publishedDate), Str.takeLeft(10)),
	highlights: Arr.take(result.highlights ?? [], 2),
});

const hitsOf = (answer: Answer): Hits => ({
	hits: Arr.map(answer.results, hitOf),
	costUsd: Option.map(Option.fromUndefinedOr(answer.costDollars), ({ total }) => total),
});

const contentOf = (answer: Answer): Option.Option<Content> =>
	Option.flatMap(Arr.head(answer.results), (result) =>
		Option.map(
			Option.filter(Option.fromUndefinedOr(result.text), (text) => Str.isNonEmpty(Str.trim(text))),
			(text) => ({ title: titleOf(result), text }),
		),
	);

const failed = (cause: unknown) => ExaError.make({ message: `Exa: ${String(cause)}` });

const noKey = ExaError.make({ message: "EXA_API_KEY is not set" });

const resilient = (http: HttpClient.HttpClient) =>
	http.pipe(
		HttpClient.filterStatusOk,
		HttpClient.retryTransient({
			retryOn: "errors-and-responses",
			times: 3,
			schedule: Schedule.exponential("500 millis"),
		}),
	);

const decodeAnswer = (text: string) =>
	Schema.decodeEffect(Schema.fromJsonString(Answer))(text).pipe(Effect.mapError(failed));

const make = (key: Option.Option<Redacted.Redacted>) =>
	Effect.map(HttpClient.HttpClient, (http) => {
		const client = resilient(http);

		const post = (path: string, body: SearchBody | ContentsBody) =>
			Option.match(key, {
				onNone: () => Effect.fail(noKey),
				onSome: (secret) =>
					HttpClientRequest.post(`https://api.exa.ai${path}`).pipe(
						HttpClientRequest.setHeader("x-api-key", Redacted.value(secret)),
						HttpClientRequest.bodyJsonUnsafe(body),
						client.execute,
						Effect.flatMap((response) => response.text),
						Effect.mapError(failed),
						Effect.flatMap(decodeAnswer),
					),
			});

		return Exa.of({
			hasKey: Option.isSome(key),
			search: (request) => Effect.map(post("/search", searchBody(request)), hitsOf),
			contents: (url) =>
				Effect.map(
					post("/contents", { urls: [url], text: true, maxAgeHours: 1, livecrawlTimeout: 15_000 }),
					contentOf,
				),
		});
	});

export const exaLayerWith = (key: Option.Option<Redacted.Redacted>): Layer.Layer<Exa, never, HttpClient.HttpClient> =>
	Layer.effect(Exa, make(key));

export const exaLayer: Layer.Layer<Exa, never, HttpClient.HttpClient> = Layer.unwrap(
	Config.Redacted("EXA_API_KEY").pipe(Config.option, Effect.orElseSucceed(Option.none), Effect.map(exaLayerWith)),
);
