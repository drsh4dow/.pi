import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";

import { type Hits, Limit, type SearchRequest, Web } from "./index.ts";
import { checkEach, type Row, webFor } from "./web.fixture.ts";

const hitsView = ({ provider, costUsd, hits }: Hits) =>
	Arr.join(
		[
			`provider ${provider}`,
			`cost ${Option.getOrElse(Option.map(costUsd, String), () => "-")}`,
			...Arr.map(hits, ({ title, url, published, highlights }) =>
				Arr.join(
					[
						`- ${title} <${url}> ${Option.getOrElse(published, () => "-")}`,
						...Arr.map(highlights, (line) => `  > ${line}`),
					],
					"\n",
				),
			),
		],
		"\n",
	);

const bunServe: SearchRequest = {
	query: "bun serve",
	limit: Limit.make(5),
	domains: ["bun.sh", "github.com"],
	since: Option.some("2026-01-01"),
};

const search = Effect.flatMap(Web, (web) => web.search(bunServe)).pipe(
	Effect.match({ onFailure: ({ kind, message }) => `${kind}: ${message}`, onSuccess: hitsView }),
);

const exaHits = () =>
	Response.json({
		results: [
			{
				title: "Bun.serve",
				url: "https://bun.sh/docs/api/http",
				publishedDate: "2026-03-01T12:00:00.000Z",
				highlights: ["one", "two", "three"],
			},
		],
		costDollars: { total: 0.007 },
	});

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const parallelResults = [
	{
		url: "https://bun.sh/docs/api/http",
		title: "HTTP server",
		publish_date: "2026-03-01",
		excerpts: [Str.repeat(400)("x")],
	},
	{ url: "https://old.example/", title: "Old", publish_date: "2020-01-01", excerpts: [] },
	{ url: "https://docs.github.com/en/x", title: "Docs", publish_date: "2026-02-01", excerpts: [] },
	{ url: "https://elsewhere.example/", title: "Elsewhere", publish_date: "2026-04-01", excerpts: [] },
	{ url: "https://bun.sh/undated", title: "Undated", excerpts: [] },
];

const parallelEvent = await Effect.runPromise(
	Effect.gen(function* () {
		const text = yield* jsonText({ search_id: "s", results: parallelResults });
		const data = yield* jsonText({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });

		return `event: message\ndata: ${data}\n\n`;
	}),
);

const parallelHits = (body: string) =>
	Str.includes("bun serve site:bun.sh OR site:github.com")(body)
		? new Response(parallelEvent, { headers: { "content-type": "text/event-stream" } })
		: new Response("", { status: 400 });

const unauthorized = () => new Response("", { status: 401 });

const busyOnce = () => {
	const calls = { count: 0 };

	return (body: string) => {
		calls.count += 1;

		return calls.count === 1 ? new Response("", { status: 429 }) : parallelHits(body);
	};
};

const rows: ReadonlyArray<Row> = [
	{
		name: "with a key, Exa answers with its cost and at most two highlights a result, and gets the domains and date",
		withExaKey: true,
		routes: {
			"POST https://api.exa.ai/search": (body) =>
				Str.includes('"includeDomains":["bun.sh","github.com"],"startPublishedDate":"2026-01-01"')(body)
					? exaHits()
					: new Response("", { status: 400 }),
		},
		expect: ["provider exa\ncost 0.007\n- Bun.serve <https://bun.sh/docs/api/http> 2026-03-01\n  > one\n  > two"],
		absent: ["three"],
	},
	{
		name: "without a key, Parallel answers, with domains as site: terms, domains and date applied here, and excerpts cut",
		withExaKey: false,
		routes: { "POST https://mcp.parallel.ai/mcp": parallelHits },
		expect: [
			"provider parallel\ncost -",
			`- HTTP server <https://bun.sh/docs/api/http> 2026-03-01\n  > ${Str.repeat(300)("x")}\n`,
			"- Docs <https://docs.github.com/en/x> 2026-02-01",
		],
		absent: ["Old", "Elsewhere", "Undated", Str.repeat(301)("x")],
	},
	{
		name: "when Exa refuses the key, Parallel answers",
		withExaKey: true,
		routes: { "POST https://api.exa.ai/search": unauthorized, "POST https://mcp.parallel.ai/mcp": parallelHits },
		expect: ["provider parallel"],
	},
	{
		name: "Parallel is asked once more after it answers 429",
		withExaKey: false,
		routes: { "POST https://mcp.parallel.ai/mcp": busyOnce() },
		expect: ["provider parallel\ncost -\n- HTTP server"],
	},
	{
		name: "when both fail, the error names each reason",
		withExaKey: true,
		routes: { "POST https://api.exa.ai/search": unauthorized, "POST https://mcp.parallel.ai/mcp": unauthorized },
		expect: ["provider: exa: ", "; parallel: https://mcp.parallel.ai/mcp answered HTTP 401"],
	},
];

checkEach(() => search)(rows);

const never = () => new Response(new ReadableStream());

const slowRows = [
	{
		name: "an Exa search that never answers gives way to Parallel after 15 s",
		parallel: parallelHits,
		expect: "provider parallel",
	},
	{
		name: "a search no provider answers gives up after 30 s",
		parallel: never,
		expect: "provider: no search answer in 30 s",
	},
];

for (const row of slowRows) {
	const routes = { "POST https://api.exa.ai/search": never, "POST https://mcp.parallel.ai/mcp": row.parallel };
	const layer = Layer.provideMerge(webFor({ withExaKey: true, routes }), TestClock.layer());

	test(row.name, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const searching = yield* Effect.forkChild(search);

				yield* TestClock.adjust("10 minutes");

				const got = yield* Fiber.join(searching);

				expect(got).toStartWith(row.expect);
			}).pipe(Effect.provide(layer)),
		),
	);
}
