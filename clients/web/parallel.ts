import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { Hit, SearchRequest } from "../exa/index.ts";
import { fetched } from "./guard.ts";
import { WebError } from "./page.ts";
import { textOf } from "./text.ts";

const optionalText = Schema.String.pipe(Schema.NullOr, Schema.optionalKey);

const Result = Schema.Struct({
	url: Schema.String,
	title: optionalText,
	publish_date: optionalText,
	excerpts: Schema.String.pipe(Schema.Array, Schema.optionalKey),
});

const Results = Schema.Struct({ results: Schema.Array(Result) });

const Content = Schema.Struct({ text: Schema.fromJsonString(Results) });

const Reply = Schema.Struct({ result: Schema.Struct({ content: Schema.Array(Content) }) });

type Result = typeof Result.Type;

const failed = (why: string) => WebError.make({ kind: "provider", message: `parallel: ${why}` });

/** The reply is one server-sent event, or plain JSON when the server skips the stream. */
const payloadOf = (body: string) => {
	const event = Arr.findFirst(Str.split(body, "\n"), Str.startsWith("data:"));

	return Option.getOrElse(Option.map(event, Str.slice(5)), () => body);
};

const hitOf = (result: Result): Hit => ({
	title: result.title ?? result.url,
	url: result.url,
	published: Option.map(Option.fromNullishOr(result.publish_date), Str.takeLeft(10)),
	highlights: Arr.map(Arr.take(result.excerpts ?? [], 2), Str.takeLeft(300)),
});

const onHost = (url: string, domain: string) => {
	const host = URL.parse(url)?.hostname ?? "";

	return host === domain || Str.endsWith(`.${domain}`)(host);
};

/** Parallel's web_search takes no per-call domain or date filter, so domains travel as site: terms and both are checked here. */
const wanted =
	({ domains, since }: SearchRequest) =>
	({ url, publish_date }: Result) =>
		(Arr.isReadonlyArrayEmpty(domains) || Arr.some(domains, (domain) => onHost(url, domain))) &&
		Option.match(since, {
			onNone: () => true,
			onSome: (from) => Option.exists(Option.fromNullishOr(publish_date), (date) => date >= from),
		});

const queryOf = ({ query, domains }: SearchRequest) =>
	Arr.join(
		[
			query,
			...Arr.intersperse(
				Arr.map(domains, (domain) => `site:${domain}`),
				"OR",
			),
		],
		" ",
	);

const call = (query: string) =>
	HttpClientRequest.post("https://mcp.parallel.ai/mcp").pipe(
		HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
		HttpClientRequest.bodyJsonUnsafe({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "web_search", arguments: { objective: query, search_queries: [query] } },
		}),
	);

const retriedOnce = Effect.map(
	HttpClient.HttpClient,
	HttpClient.retryTransient({ retryOn: "response-only", times: 1, schedule: Schedule.spaced("500 millis") }),
);

export const parallelSearch = (request: SearchRequest) =>
	Effect.gen(function* () {
		const page = yield* fetched(call(queryOf(request))).pipe(
			Effect.provideServiceEffect(HttpClient.HttpClient, retriedOnce),
		);

		const reply = yield* Schema.decodeEffect(Schema.fromJsonString(Reply))(payloadOf(textOf(page))).pipe(
			Effect.mapError(() => failed("unexpected answer")),
		);

		const results = Arr.flatMap(reply.result.content, ({ text }) => text.results);

		const kept = Arr.filter(results, wanted(request));

		return Arr.map(Arr.take(kept, request.limit), hitOf);
	}).pipe(Effect.mapError(({ message }) => failed(message)));
