import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import {
	bytes,
	docsPage,
	html,
	markdown,
	missing,
	oddStatus,
	pdfBytes,
	plain,
	prose,
	redirect,
} from "./transport.fixture.ts";
import { type ReadRow, readRows } from "./web.fixture.ts";

const latin1 = (text: string) => Buffer.from(text, "latin1");

const rows: ReadonlyArray<ReadRow> = [
	{
		name: "a site that answers Accept: text/markdown is read as served",
		url: "https://nextjs.org/docs/app",
		routes: { "GET https://nextjs.org/docs/app": markdown(`# App Router\n\n${prose("Next")}`) },
		expect: ["via direct", "title App Router", "# App Router\n\nNext starts"],
	},
	{
		name: "an HTML page with a .md copy beside it, as Mintlify and Bun publish, is read from the copy",
		url: "https://bun.sh/docs/api/http",
		routes: {
			"GET https://bun.sh/docs/api/http": docsPage("HTTP server"),
			"GET https://bun.sh/docs/api/http.md": plain(
				`# HTTP server\n\n\`\`\`ts\nBun.serve({});\n\`\`\`\n\n${prose("Bun")}`,
			),
		},
		expect: ["final https://bun.sh/docs/api/http.md", "```ts\nBun.serve({});\n```"],
	},
	{
		name: "an HTML page with no .md copy keeps its Shiki code block and its links, and drops the chrome",
		url: "https://bun.sh/docs/api/http",
		routes: {
			"GET https://bun.sh/docs/api/http": docsPage("HTTP server"),
			"GET https://bun.sh/docs/api/http.md": missing,
		},
		expect: [
			"title HTTP server",
			"```\nconst server = Bun.serve({ port: 3000 });\n```",
			"[reference](https://bun.sh/docs/api/http)",
		],
		absent: ["Copyright"],
	},
	{
		name: "a .md path that an SPA answers with its HTML shell is ignored",
		url: "https://app.example/docs/x",
		routes: {
			"GET https://app.example/docs/x": docsPage("Guide"),
			"GET https://app.example/docs/x.md": docsPage("Home"),
		},
		expect: ["final https://app.example/docs/x\n", "title Guide"],
	},
	{
		name: "a Cloudflare challenge sends the agent to a browser",
		url: "https://www.npmjs.com/search?q=effect",
		routes: {
			"GET https://www.npmjs.com/search?q=effect": () =>
				new Response("<p>Enable JavaScript and cookies</p>", {
					status: 403,
					headers: { "cf-mitigated": "challenge" },
				}),
		},
		expect: [
			"needs-browser: direct: https://www.npmjs.com/search?q=effect answered HTTP 403 with a bot check",
			"use the agent-browser skill",
		],
	},
	{
		name: "a 503 whose body is a bot check sends the agent to a browser",
		url: "https://guarded.example/",
		routes: {
			"GET https://guarded.example/": () => new Response("<title>Just a moment...</title>", { status: 503 }),
		},
		expect: ["needs-browser: direct: https://guarded.example/ answered HTTP 503 with a bot check"],
	},
	{
		name: "a Cloudflare challenge still lets Exa try",
		url: "https://guarded.example/",
		withExaKey: true,
		routes: {
			"GET https://guarded.example/": () =>
				new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } }),
			"POST https://api.exa.ai/contents": () =>
				Response.json({ results: [{ url: "https://guarded.example/", text: prose("Exa") }] }),
		},
		expect: ["via exa", "Exa starts"],
	},
	{
		name: "a status outside 200-599 is a bad answer that names the status",
		url: "https://www.linkedin.com/in/someone",
		routes: { "GET https://www.linkedin.com/in/someone": oddStatus(999) },
		expect: ["bad-answer: direct: https://www.linkedin.com/in/someone answered HTTP 999"],
	},
	{
		name: "an HTML page in Latin-1 is decoded with the charset it names",
		url: "https://latin.example/menu",
		routes: {
			"GET https://latin.example/menu": () =>
				new Response(latin1(`<title>Café</title><article><p>Crème brûlée. ${prose("Café")}</p></article>`), {
					headers: { "content-type": "text/html; charset=ISO-8859-1" },
				}),
			"GET https://latin.example/menu.md": missing,
		},
		expect: ["title Café", "Crème brûlée."],
	},
	{
		name: "a text file in Latin-1 is decoded with the charset it names",
		url: "https://latin.example/notes.txt",
		routes: {
			"GET https://latin.example/notes.txt": bytes('text/plain; charset="iso-8859-1"')(latin1("Crème brûlée")),
		},
		expect: ["Crème brûlée"],
	},
	{
		name: "a PDF keeps its bytes and gets its text as markdown",
		url: "https://arxiv.org/pdf/1706.03762",
		routes: { "GET https://arxiv.org/pdf/1706.03762": bytes("application/pdf")(pdfBytes) },
		expect: [`application/pdf ${String(pdfBytes.length)} bytes`, "<!-- page 1 -->\nAttention is all"],
	},
	{
		name: "a PDF sent as application/octet-stream still gets its text as markdown",
		url: "https://files.example/paper",
		routes: { "GET https://files.example/paper": bytes("application/octet-stream")(pdfBytes) },
		expect: [`application/pdf ${String(pdfBytes.length)} bytes`, "<!-- page 1 -->\nAttention is all"],
	},
	{
		name: "a PDF sent with no type still gets its text as markdown",
		url: "https://files.example/untyped",
		routes: { "GET https://files.example/untyped": () => new Response(pdfBytes) },
		expect: [`application/pdf ${String(pdfBytes.length)} bytes`, "<!-- page 1 -->\nAttention is all"],
	},
	{
		name: "HTML over 2 MB is cut before it is converted, and the caveat says so",
		url: "https://huge.example/",
		routes: {
			"GET https://huge.example/": html(
				`<title>Huge</title><article>${Str.repeat(5000)(`<p>${prose("Huge")}</p>`)}<p>TAIL-MARKER</p></article>`,
			),
		},
		expect: ["via direct", "Only the first 2 MB of this page's HTML was converted.", "Huge starts"],
		absent: ["TAIL-MARKER"],
	},
	{
		name: "an image keeps its bytes and has no markdown",
		url: "https://img.example/a.png",
		routes: { "GET https://img.example/a.png": bytes("image/png")(new Uint8Array([137, 80, 78, 71])) },
		expect: ["image/png 4 bytes\nno markdown"],
	},
	{
		name: "a 404 is gone",
		url: "https://docs.example/old",
		routes: { "GET https://docs.example/old": missing },
		expect: ["gone: https://docs.example/old answered HTTP 404"],
	},
	{
		name: "a server error is a bad answer, and without a key Exa is not tried",
		url: "https://docs.example/broken",
		routes: { "GET https://docs.example/broken": () => new Response("", { status: 500 }) },
		expect: ["bad-answer: direct: https://docs.example/broken answered HTTP 500."],
		absent: ["agent-browser", "exa:"],
	},
	{
		name: "a bot check is not taken for the page",
		url: "https://guarded.example/",
		routes: { "GET https://guarded.example/": html("<title>Just a moment...</title><p>Just a moment...</p>") },
		expect: ["needs-browser: direct: bot check"],
	},
	{
		name: "a short page comes back with a caveat that it may need a browser",
		url: "https://tiny.example/",
		routes: { "GET https://tiny.example/": markdown("# Tiny\n\nShort.") },
		expect: ["Short page.", "# Tiny"],
	},
	{
		name: "a redirect to a private address is refused at that hop",
		url: "https://short.example/x",
		routes: { "GET https://short.example/x": redirect("http://169.254.169.254/latest/meta-data") },
		expect: ["blocked: 169.254.169.254: a private address"],
	},
	{
		name: "a redirect to a public page is followed and named as the final URL",
		url: "https://short.example/y",
		routes: {
			"GET https://short.example/y": redirect("/z"),
			"GET https://short.example/z": markdown(`# Moved\n\n${prose("Moved")}`),
		},
		expect: ["final https://short.example/z"],
	},
	{
		name: "a request carries pi-web's User-Agent and no tracing headers",
		url: "https://echo.example/",
		routes: {
			"GET https://echo.example/": (_body, headers) =>
				new Response(
					`# Echo\n\nua=${headers["user-agent"] ?? "none"} traceparent=${headers["traceparent"] ?? "none"} b3=${headers["b3"] ?? "none"}\n\n${prose("Echo")}`,
					{ headers: { "content-type": "text/markdown" } },
				),
		},
		expect: ["ua=pi-web/1 (", "traceparent=none", "b3=none"],
	},
	{
		name: "a chain of redirects stops after the fifth",
		url: "https://short.example/hop/1",
		routes: {
			...Rec.fromEntries(
				Arr.map([1, 2, 3, 4, 5, 6], (hop) => [
					`GET https://short.example/hop/${String(hop)}`,
					redirect(`/hop/${String(hop + 1)}`),
				]),
			),
			"GET https://short.example/hop/7": markdown(`# Arrived\n\n${prose("Arrived")}`),
		},
		expect: ["https://short.example/hop/6 answered HTTP 302"],
		absent: ["Arrived"],
	},
	{
		name: "a body over 25 MB is refused",
		url: "https://big.example/dump.txt",
		routes: { "GET https://big.example/dump.txt": plain(Str.repeat(26 * 1024 * 1024)("x")) },
		expect: ["too-large: https://big.example/dump.txt is over 25 MB"],
	},
];

readRows(rows);
