import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { Exa, ExaError, exaLayer, type Hit, type SearchRequest } from "../exa/index.ts";
import { githubTokenLayer } from "./github.ts";
import { guardedHttp, nodeTransport, type PublicUrl } from "./guard.ts";
import { type Page, WebError } from "./page.ts";
import { parallelSearch } from "./parallel.ts";
import { readPage } from "./sources.ts";

export { PublicUrl } from "./guard.ts";

export { Body, WebError, type Page } from "./page.ts";

export type { Via } from "./sources.ts";

export { type Hit, Limit, type SearchRequest } from "../exa/index.ts";

export interface Hits {
	readonly provider: "exa" | "parallel";
	readonly hits: ReadonlyArray<Hit>;
	readonly costUsd: Option.Option<number>;
}

export class Web extends Context.Service<
	Web,
	{
		readonly search: (request: SearchRequest) => Effect.Effect<Hits, WebError>;
		readonly read: (url: PublicUrl) => Effect.Effect<Page, WebError>;
	}
>()("pi-harness/clients/web/Web") {}

const parallelHits = (hits: ReadonlyArray<Hit>): Hits => ({ provider: "parallel", hits, costUsd: Option.none() });

const fallback = (request: SearchRequest) => (exa: ExaError) =>
	Effect.mapBoth(parallelSearch(request), {
		onFailure: (parallel) => WebError.make({ kind: "provider", message: `exa: ${exa.message}; ${parallel.message}` }),
		onSuccess: parallelHits,
	});

/** Exa's four tries of up to 30 s each could take two minutes, so its turn ends at 15 s to leave Parallel the other 15 s, and a search never outlasts the 30 s of a single fetch. */
const exaTooSlow = ExaError.make({ message: "no answer in 15 s" });

const searchTooSlow = WebError.make({ kind: "provider", message: "no search answer in 30 s" });

const makeWeb = Effect.gen(function* () {
	const context = yield* Effect.context<HttpClient.HttpClient | Exa>();
	const exa = yield* Exa;

	const search = (request: SearchRequest) =>
		exa.search(request).pipe(
			Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(exaTooSlow) }),
			Effect.map((found): Hits => ({ provider: "exa", ...found })),
			Effect.catchTag("ExaError", fallback(request)),
			Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(searchTooSlow) }),
		);

	return Web.of({
		search: (request) => Effect.provideContext(search(request), context),
		read: (url) => Effect.provideContext(readPage(url), context),
	});
});

export interface WebOptions {
	readonly transport: Layer.Layer<HttpClient.HttpClient>;
	readonly exa: Layer.Layer<Exa, never, HttpClient.HttpClient>;
}

export const webLayerWith = ({ transport, exa }: WebOptions): Layer.Layer<Web> => {
	const http = guardedHttp(transport);

	return Layer.effect(Web, makeWeb).pipe(Layer.provide(Layer.provideMerge(exa, http)));
};

export const webLayer: Layer.Layer<Web> = webLayerWith({ transport: nodeTransport, exa: exaLayer }).pipe(
	Layer.provide(Layer.provide(githubTokenLayer, NodeServices.layer)),
);
