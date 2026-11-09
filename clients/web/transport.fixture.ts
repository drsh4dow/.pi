import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Str from "effect/String";

/** A function, because a Response body can be read only once. */
export type Reply = (body: string, headers: Headers.Headers) => Response;

export type Routes = Readonly<Record<string, Reply>>;

export const fakeTransport = (routes: Routes): Layer.Layer<HttpClient.HttpClient> =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request, url) => {
			const key = `${request.method} ${url.origin}${url.pathname}${url.search}`;
			const reply = routes[key];

			const body = Match.value(request.body).pipe(
				Match.tag("Uint8Array", ({ body: bytes }) => new TextDecoder().decode(bytes)),
				Match.orElse(() => ""),
			);

			return reply === undefined
				? Effect.die(`no route for ${key}`)
				: Effect.succeed(HttpClientResponse.fromWeb(request, reply(body, request.headers)));
		}),
	);

const typed = (type: string) => (body: string) => () => new Response(body, { headers: { "content-type": type } });

export const markdown = typed("text/markdown; charset=utf-8");

export const html = typed("text/html; charset=utf-8");

export const plain = typed("text/plain; charset=utf-8");

export const bytes = (type: string) => (body: Uint8Array) => () =>
	new Response(body, { headers: { "content-type": type } });

export const missing = () =>
	new Response("<h1>Not Found</h1>", { status: 404, headers: { "content-type": "text/html" } });

export const dropsMidBody = () =>
	new Response(
		new ReadableStream({
			start: (controller) => {
				controller.error(new Error("connection reset"));
			},
		}),
	);

/** A web Response refuses a status outside 200-599, so this sets one on the object, as Node's client reports LinkedIn's 999. */
export const oddStatus = (status: number) => () => {
	const response = new Response("");

	Object.defineProperty(response, "status", { value: status });

	return response;
};

export const redirect = (location: string) => () => new Response("", { status: 302, headers: { location } });

export const prose = (topic: string) =>
	Str.repeat(6)(
		`${topic} starts an HTTP server. It takes a fetch handler and returns a server you can stop or reload. `,
	);

export const docsPage = (title: string) =>
	html(`<!doctype html><html><head><title>${title}</title></head><body><nav><a href="/">Home</a></nav><main>
<article><h1>${title}</h1><p>${prose(title)}</p>
<pre class="shiki"><code><span class="line"><span style="color:#F97583">const</span><span> server = Bun.</span><span style="color:#B392F0">serve</span><span>({ port: 3000 });</span></span></code></pre>
<p>See the <a href="https://bun.sh/docs/api/http">reference</a>.</p></article></main><footer>Copyright</footer></body></html>`);

export const pdfBytes = new TextEncoder().encode(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 10 50 Td (Attention is all) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`);
