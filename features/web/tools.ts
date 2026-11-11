import type { JsonValue } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Static, Type } from "typebox";

import { Limit, PublicUrl, Web, WebError } from "../../clients/web/index.ts";
import { Store } from "./store.ts";
import { fetchReply, hitsJson } from "./view.ts";

const Host = Type.String({ minLength: 1 });

const SearchParams = Type.Object({
	query: Type.String({ minLength: 1, description: "What you want to find, in plain words." }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Results to return. Default 5." })),
	domains: Type.Optional(Type.Array(Host, { description: 'Only these hosts, such as ["bun.sh"].' })),
	since: Type.Optional(
		Type.String({ format: "date", description: "Only pages published on or after this date, YYYY-MM-DD." }),
	),
});

const FetchParams = Type.Object({ url: Type.String({ minLength: 1, description: "An http or https URL." }) });

const annotations = { readOnlyHint: true, openWorldHint: true };

export interface Reply {
	readonly text: string;
	readonly json: JsonValue;
}

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const asJson = (json: JsonValue) => Effect.map(Effect.orDie(encode(json)), (text): Reply => ({ text, json }));

export const searchCall = ({ query, limit, domains, since }: Static<typeof SearchParams>) =>
	Effect.flatMap(Web, (web) =>
		web.search({
			query,
			limit: Limit.make(limit ?? 5),
			domains: domains ?? [],
			since: Option.fromUndefinedOr(since),
		}),
	).pipe(Effect.flatMap((hits) => asJson(hitsJson(hits))));

const target = (url: string) =>
	Schema.decodeEffect(PublicUrl)(url).pipe(
		Effect.mapError(({ message }) => WebError.make({ kind: "blocked", message })),
	);

export const fetchCall = ({ url }: Static<typeof FetchParams>) =>
	Effect.gen(function* () {
		const web = yield* Web;
		const store = yield* Store;
		const page = yield* Effect.flatMap(target(url), web.read);
		const saved = yield* store.save(page);

		return fetchReply({ page, saved });
	});

type Runtime = ManagedRuntime.ManagedRuntime<Web | Store, never>;

const resultOf = ({ text, json }: Reply, isError: boolean) => ({
	content: [{ type: "text" as const, text }],
	details: json,
	structuredContent: json,
	isError,
});

export const replyOf = <Needs extends Web | Store>(call: Effect.Effect<Reply, WebError, Needs>) =>
	Effect.matchEffect(call, {
		onFailure: ({ kind, message }) => Effect.map(asJson({ error: kind, message }), (reply) => resultOf(reply, true)),
		onSuccess: (reply) => Effect.succeed(resultOf(reply, false)),
	});

export const webTools = (runtime: Runtime) => [
	defineTool({
		name: "web_search",
		label: "web search",
		description:
			"Search the web. Returns up to 10 results, each with its title, URL, date and a short excerpt. Read a result with web_fetch.",
		annotations,
		parameters: SearchParams,
		execute: (_id, params, signal) => runtime.runPromise(replyOf(searchCall(params)), { signal }),
	}),
	defineTool({
		name: "web_fetch",
		label: "web fetch",
		description:
			"Read one URL. Web pages, GitHub files, issues and trees, npm, Hacker News and Reddit come back as markdown, a PDF as a saved file plus its markdown, other files as a saved path. The whole result is saved to disk and its start is shown.",
		annotations,
		parameters: FetchParams,
		execute: (_id, params, signal) => runtime.runPromise(replyOf(fetchCall(params)), { signal }),
	}),
];
