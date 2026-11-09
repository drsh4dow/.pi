import { type LookupAddress, type LookupOptions, lookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { WebError } from "./page.ts";
import { type Fetched, mimeOf, textOf } from "./text.ts";

const caps = { redirects: 5, timeout: "30 seconds", maxBytes: 25 * 1024 * 1024 } as const;

const userAgent = "pi-web/1 (personal coding agent; +https://github.com/earendil-works/pi)";

const ipv4Ranges = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const;

const ipv6Ranges = [
	["64:ff9b:1::", 48],
	["2001::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const;

/** IPv6 ranges that carry an IPv4 address in the 32 bits after their prefix, given that address as two hex groups. */
const ipv4Carriers = [
	[(high: string, low: string) => `::${high}:${low}`, 96],
	[(high: string, low: string) => `::ffff:${high}:${low}`, 96],
	[(high: string, low: string) => `::ffff:0:${high}:${low}`, 96],
	[(high: string, low: string) => `64:ff9b::${high}:${low}`, 96],
	[(high: string, low: string) => `2002:${high}:${low}::`, 16],
] as const;

const hexGroups = (ipv4: string) => {
	const [first, second = 0, third = 0, fourth = 0] = Arr.map(Str.split(ipv4, "."), Number);

	return [(first * 256 + second).toString(16), (third * 256 + fourth).toString(16)] as const;
};

const privateAddresses = new BlockList();

for (const [network, prefix] of ipv4Ranges) {
	const [high, low] = hexGroups(network);

	privateAddresses.addSubnet(network, prefix, "ipv4");

	for (const [carrying, bits] of ipv4Carriers) {
		privateAddresses.addSubnet(carrying(high, low), bits + prefix, "ipv6");
	}
}

for (const [network, prefix] of ipv6Ranges) {
	privateAddresses.addSubnet(network, prefix, "ipv6");
}

export const isPublicAddress = (address: string): boolean => {
	const family = isIP(address);

	return family !== 0 && !privateAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
};

const isLocalName = (host: string) =>
	host === "localhost" || Str.endsWith(".localhost")(host) || Str.endsWith(".internal")(host);

const refusals: ReadonlyArray<{ readonly why: string; readonly refuses: (url: URL, host: string) => boolean }> = [
	{ why: "only http and https URLs", refuses: (url) => url.protocol !== "http:" && url.protocol !== "https:" },
	{ why: "a URL with a user name or password", refuses: (url) => `${url.username}${url.password}` !== "" },
	{ why: "a local host name", refuses: (_url, host) => isLocalName(host) },
	{ why: "a private address", refuses: (_url, host) => isIP(host) !== 0 && !isPublicAddress(host) },
];

export const problemOf = (raw: string): Option.Option<string> => {
	if (!URL.canParse(raw)) {
		return Option.some(`${raw}: not a URL`);
	}

	const url = new URL(raw);
	const host = Str.replace(/^\[(?<inside>.*)\]$/u, "$<inside>")(url.hostname);
	const refusal = Arr.findFirst(refusals, ({ refuses }) => refuses(url, host));

	return Option.map(refusal, ({ why }) => `${url.hostname}: ${why}`);
};

export const PublicUrl = Schema.String.pipe(
	Schema.check(
		Schema.makeFilter((raw) => Option.getOrElse(problemOf(raw), () => true), {
			description: "an http(s) URL with no credentials and no private address",
		}),
	),
	Schema.brand("PublicUrl"),
);

export type PublicUrl = typeof PublicUrl.Type;

const refusalOf = (hostname: string, addresses: ReadonlyArray<LookupAddress>) =>
	Option.map(
		Arr.findFirst(addresses, ({ address }) => !isPublicAddress(address)),
		({ address }) =>
			WebError.make({ kind: "blocked", message: `${hostname} resolves to ${address}, a private address` }),
	);

export type Resolve = (
	hostname: string,
	options: LookupOptions,
	done: (error: NodeJS.ErrnoException | null | undefined, addresses: ReadonlyArray<LookupAddress>) => void,
) => void;

const systemResolve: Resolve = (hostname, options, done) => {
	lookup(hostname, { ...options, all: true }, done);
};

export const lookupWith =
	(resolve: Resolve): LookupFunction =>
	(hostname, options, callback) => {
		resolve(hostname, options, (error, addresses) => {
			if (Predicate.isNotNullish(error)) {
				callback(error, "", 0);

				return;
			}

			const refusal = Option.getOrNull(refusalOf(hostname, addresses));
			const [first] = addresses;

			if (options.all === true) {
				callback(refusal, [...addresses]);

				return;
			}

			callback(refusal, first?.address ?? "", first?.family ?? 0);
		});
	};

const noAnswer = (url: string) => WebError.make({ kind: "unreachable", message: `${url}: no answer in 30 s` });

const tooLarge = (url: string) => WebError.make({ kind: "too-large", message: `${url} is over 25 MB` });

const failure = (request: HttpClientRequest.HttpClientRequest, error: WebError) =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.TransportError({ request, cause: error, description: error.message }),
	});

const bodyOf = (response: HttpClientResponse.HttpClientResponse) =>
	Stream.runFoldEffect(
		response.stream,
		() => ({ size: 0, chunks: new Array<Uint8Array>() }),
		(body, chunk) => {
			body.size += chunk.length;
			body.chunks.push(chunk);

			return body.size > caps.maxBytes
				? Effect.fail(failure(response.request, tooLarge(response.request.url)))
				: Effect.succeed(body);
		},
	).pipe(Effect.map(({ chunks }) => Buffer.concat(chunks)));

const bufferedUnderCap = (response: HttpClientResponse.HttpClientResponse) => {
	const { request, status, headers } = response;

	if (status < 200 || status > 599) {
		const odd = WebError.make({ kind: "bad-answer", message: `${request.url} answered HTTP ${String(status)}` });

		return Effect.fail(failure(request, odd));
	}

	return Effect.map(bodyOf(response), (bytes) =>
		HttpClientResponse.fromWeb(request, new Response(bytes.length === 0 ? undefined : bytes, { status, headers })),
	);
};

const guarding = (client: HttpClient.HttpClient) =>
	HttpClient.transform(client, (response, request) =>
		Option.match(problemOf(request.url), {
			onSome: (why) => Effect.fail(failure(request, WebError.make({ kind: "blocked", message: why }))),
			onNone: () =>
				Effect.flatMap(response, bufferedUnderCap).pipe(
					Effect.timeoutOrElse({
						duration: caps.timeout,
						orElse: () => Effect.fail(failure(request, noAnswer(request.url))),
					}),
				),
		}),
	);

/**
 * Every request through this client, Exa's included, has its URL checked, at most 25 MB of body and 30 s to answer,
 * and no traceparent or b3 header, which would hand every site our trace ids. It follows no redirect, so a key header
 * never reaches another host. `fetched` follows them, and `followRedirects` re-enters only the response half of this
 * client, where `HttpClient.transform` sits, so each hop is checked.
 */
export const guardedHttp = (transport: Layer.Layer<HttpClient.HttpClient>): Layer.Layer<HttpClient.HttpClient> =>
	Layer.effect(
		HttpClient.HttpClient,
		Effect.map(HttpClient.HttpClient, (client) =>
			guarding(client).pipe(
				HttpClient.mapRequest(HttpClientRequest.setHeader("user-agent", userAgent)),
				HttpClient.transformResponse(Effect.provideService(HttpClient.TracerPropagationEnabled, false)),
			),
		),
	).pipe(Layer.provide(transport));

/** `lookupWith` hands the agent the addresses it checked, so the socket connects to exactly those and a second DNS answer (rebinding) cannot slip in. Node's per-client http agents ignore HTTP(S)_PROXY, which would resolve DNS itself and skip the pin. */
export const transportWith = (resolve: Resolve): Layer.Layer<HttpClient.HttpClient> =>
	NodeHttpClient.layerNodeHttpOptions({ lookup: lookupWith(resolve) });

export const nodeTransport = transportWith(systemResolve);

export const botCheck = /just a moment|performing security verification|checking your browser|verify you are human/iu;

const isChallenge = (page: Fetched) =>
	(page.status === 403 || page.status === 503) &&
	(page.headers["cf-mitigated"] === "challenge" || botCheck.test(textOf(page)));

const failedKind = (page: Fetched): WebError["kind"] => {
	if (page.status === 404 || page.status === 410) {
		return "gone";
	}

	return isChallenge(page) ? "needs-browser" : "bad-answer";
};

const ok = (page: Fetched): Effect.Effect<Fetched, WebError> => {
	if (page.status >= 200 && page.status < 300) {
		return Effect.succeed(page);
	}

	const kind = failedKind(page);
	const check = kind === "needs-browser" ? " with a bot check" : "";

	return Effect.fail(
		WebError.make({ kind, message: `${page.finalUrl} answered HTTP ${String(page.status)}${check}` }),
	);
};

const isWebError = Schema.is(WebError);

const failWith = ({ reason, message }: HttpClientError.HttpClientError) =>
	Effect.fail(isWebError(reason.cause) ? reason.cause : WebError.make({ kind: "unreachable", message }));

export const fetched = (
	request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Fetched, WebError, HttpClient.HttpClient> =>
	Effect.flatMap(HttpClient.HttpClient, (client) =>
		HttpClient.followRedirects(client, caps.redirects).execute(request),
	).pipe(
		Effect.flatMap((response) =>
			Effect.map(response.arrayBuffer, (buffer) => ({
				status: response.status,
				finalUrl: response.request.url,
				mime: mimeOf(response.headers),
				headers: response.headers,
				bytes: new Uint8Array(buffer),
			})),
		),
		Effect.catchTag("HttpClientError", failWith),
		Effect.timeoutOrElse({
			duration: caps.timeout,
			orElse: () => Effect.fail(noAnswer(request.url)),
		}),
		Effect.flatMap(ok),
	);
