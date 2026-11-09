import * as Str from "effect/String";

import { docsPage, dropsMidBody, html, markdown, missing, plain, prose, redirect } from "./transport.fixture.ts";
import { type ReadRow, readRows } from "./web.fixture.ts";

const redditEntry = (author: string, date: string, title: string, content: string) =>
	`<entry><author><name>/u/${author}</name></author><content type="html">${Str.replaceAll("<", "&lt;")(content)}</content><updated>${date}T00:00:00+00:00</updated><title>${title}</title></entry>`;

const redditFeed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>bun hangs</title>${redditEntry(
	"alice",
	"2026-02-01",
	"bun hangs",
	'<div class="md"><p>It hangs on <a href="https://bun.sh/docs/cli/install">install</a>.</p></div>',
)}${redditEntry("bob", "2026-02-02", "/u/bob on bun hangs", '<div class="md"><p>Same here, see <a href="/r/bun/wiki">the wiki</a>.</p></div>')}</feed>`;

const exaCopy = (url: string, text: string) => () => Response.json({ results: [{ url, title: "Exa", text }] });

const rows: ReadonlyArray<ReadRow> = [
	{
		name: "an npm package is read as its README at that version, whatever the file's case",
		url: "https://www.npmjs.com/package/@scope/tool/v/2.1.0",
		routes: {
			"GET https://cdn.jsdelivr.net/npm/@scope/tool@2.1.0/README.md": missing,
			"GET https://cdn.jsdelivr.net/npm/@scope/tool@2.1.0/readme.md": markdown("# tool\n\nUsage."),
		},
		expect: ["via npm", "title @scope/tool@2.1.0 README", "# tool\n\nUsage."],
		absent: ["Short page."],
	},
	{
		name: "a look-alike of npmjs.com is not read as npm",
		url: "https://evilnpmjs.com/package/effect",
		routes: {
			"GET https://evilnpmjs.com/package/effect": docsPage("effect"),
			"GET https://evilnpmjs.com/package/effect.md": missing,
		},
		expect: ["via direct", "title effect"],
	},
	{
		name: "a Hacker News page that is not an item, such as a reply form, is read directly",
		url: "https://news.ycombinator.com/reply?id=42",
		routes: {
			"GET https://hn.algolia.com/api/v1/items/42": () =>
				Response.json({ title: "Story", author: "pg", created_at: "2026-01-01T00:00:00Z", children: [] }),
			"GET https://news.ycombinator.com/reply?id=42": docsPage("Reply"),
			"GET https://news.ycombinator.com/reply.md": missing,
		},
		expect: ["via direct", "title Reply"],
	},
	{
		name: "a Hacker News item comes back with every comment and author, each reply one quote level deeper",
		url: "https://news.ycombinator.com/item?id=42",
		routes: {
			"GET https://hn.algolia.com/api/v1/items/42": () =>
				Response.json({
					title: "Show HN: a pager",
					url: "https://pager.example",
					author: "pg",
					created_at: "2026-01-01T00:00:00Z",
					children: [
						{
							author: "alice",
							created_at: "2026-01-02T00:00:00Z",
							text: 'it&#x27;s <a href="https://docs.example/x">docs.example/x</a><p>second',
							children: [{ author: "bob", created_at: "2026-01-03T00:00:00Z", text: "reply", children: [] }],
						},
						{ created_at: "2026-01-04T00:00:00Z", children: [] },
						{
							author: "carol",
							created_at: "2026-01-05T00:00:00Z",
							text: `Hi, see <a href="item?id=41">the parent</a>.<p>${prose("Bun")}`,
							children: [],
						},
					],
				}),
		},
		expect: [
			"# Show HN: a pager\n\n[https://pager.example](https://pager.example/)\n\n**pg**, 2026-01-01",
			"**alice**, 2026-01-02\n\nit's [docs.example/x](https://docs.example/x)\n\nsecond",
			"> **bob**, 2026-01-03\n> \n> reply",
			String.raw`**\[deleted\]**, 2026-01-04`,
			"**carol**, 2026-01-05\n\nHi, see [the parent](https://news.ycombinator.com/item?id=41).",
		],
	},
	{
		name: "a Hacker News item that Algolia does not have, such as a flagged one, is read from HN's page",
		url: "https://news.ycombinator.com/item?id=50424972",
		routes: {
			"GET https://hn.algolia.com/api/v1/items/50424972": missing,
			"GET https://news.ycombinator.com/item?id=50424972": docsPage("Flagged story"),
			"GET https://news.ycombinator.com/item.md": missing,
		},
		expect: ["via direct", "title Flagged story"],
	},
	{
		name: "a Hacker News item HN itself has no page for is gone, and nothing else is asked",
		url: "https://news.ycombinator.com/item?id=99999999999",
		withExaKey: true,
		routes: {
			"GET https://hn.algolia.com/api/v1/items/99999999999": missing,
			"GET https://news.ycombinator.com/item?id=99999999999": () =>
				new Response("No such item.", { headers: { "content-type": "text/html" } }),
		},
		expect: ["gone: https://news.ycombinator.com/item?id=99999999999: Hacker News has no such item."],
	},
	{
		name: "a Reddit thread whose feed is gone is gone, and nothing else is asked",
		url: "https://www.reddit.com/r/bun/comments/gone/x/",
		withExaKey: true,
		routes: { "GET https://www.reddit.com/r/bun/comments/gone/x/.rss": missing },
		expect: ["gone: https://www.reddit.com/r/bun/comments/gone/x/.rss answered HTTP 404"],
	},
	{
		name: "a Reddit thread is read from its feed, with the post first and a caveat that replies are flat",
		url: "https://old.reddit.com/r/bun/comments/abc/hangs/",
		routes: {
			"GET https://www.reddit.com/r/bun/comments/abc/hangs/.rss": () =>
				new Response(redditFeed, { headers: { "content-type": "application/atom+xml" } }),
		},
		expect: [
			"via reddit",
			"comments arrive flat",
			"# bun hangs\n\n**alice**, 2026-02-01\n\nIt hangs on [install](https://bun.sh/docs/cli/install).",
			"---\n\n**bob**, 2026-02-02\n\nSame here, see [the wiki](https://www.reddit.com/r/bun/wiki).",
		],
	},
	{
		name: "a Docsify hash route is read from the markdown file it renders",
		url: "https://docs.example/site/index.html#/guide/setup?id=install",
		routes: { "GET https://docs.example/site/guide/setup.md": plain("# Setup\n\nRun it.") },
		expect: ["via docsify", "final https://docs.example/site/guide/setup.md", "# Setup"],
	},
	{
		name: "a hash route that leaves the page's origin is left to direct",
		url: "https://docs.example/#///evil.example/x",
		routes: { "GET https://docs.example/": docsPage("Docs") },
		expect: ["via direct", "title Docs"],
	},
	{
		name: "a hash route that an app answers with its HTML shell is left to direct",
		url: "https://app.example/#/dashboard",
		routes: {
			"GET https://app.example/dashboard.md": docsPage("App"),
			"GET https://app.example/": docsPage("Dashboard"),
		},
		expect: ["via direct", "title Dashboard"],
	},
	{
		name: "a page every other source failed is read from Exa's copy, with a caveat",
		url: "https://docs.example/broken",
		withExaKey: true,
		routes: {
			"GET https://docs.example/broken": () => new Response("", { status: 500 }),
			"POST https://api.exa.ai/contents": (body) =>
				Str.includes('"urls":["https://docs.example/broken"]')(body)
					? Response.json({
							results: [{ url: "https://docs.example/broken", title: "Broken", text: prose("Exa") }],
						})
					: new Response("", { status: 400 }),
		},
		expect: ["via exa", "title Broken", "Exa copy: links stripped", "Exa starts"],
	},
	{
		name: "Exa is sent the URL without its fragment",
		url: "https://docs.example/broken#intro",
		withExaKey: true,
		routes: {
			"GET https://docs.example/broken": () => new Response("", { status: 500 }),
			"POST https://api.exa.ai/contents": (body) =>
				Str.includes('"urls":["https://docs.example/broken"]')(body)
					? exaCopy("https://docs.example/broken", prose("Exa"))()
					: new Response("", { status: 400 }),
		},
		expect: ["via exa", "Exa starts"],
	},
	{
		name: "a bot check falls through to Exa's copy",
		url: "https://guarded.example/",
		withExaKey: true,
		routes: {
			"GET https://guarded.example/": html("<title>Just a moment...</title><p>Just a moment...</p>"),
			"POST https://api.exa.ai/contents": exaCopy("https://guarded.example/", prose("Exa")),
		},
		expect: ["via exa", "Exa starts"],
	},
	{
		name: "a thin page lets the next source win",
		url: "https://tiny.example/",
		withExaKey: true,
		routes: {
			"GET https://tiny.example/": markdown("# Tiny\n\nShort."),
			"POST https://api.exa.ai/contents": exaCopy("https://tiny.example/", prose("Exa")),
		},
		expect: ["via exa", "Exa starts"],
		absent: ["Short page."],
	},
	{
		name: "of two thin pages, the longer one comes back",
		url: "https://tiny.example/",
		withExaKey: true,
		routes: {
			"GET https://tiny.example/": markdown("# Tiny\n\nShort, but longer than Exa's copy."),
			"POST https://api.exa.ai/contents": exaCopy("https://tiny.example/", "Tiny."),
		},
		expect: ["via direct", "Short, but longer", "Short page."],
	},
	{
		name: "of two thin pages, the longer one comes back even when it came last",
		url: "https://tiny.example/",
		withExaKey: true,
		routes: {
			"GET https://tiny.example/": markdown("# Tiny\n\nShort."),
			"POST https://api.exa.ai/contents": exaCopy("https://tiny.example/", "Exa's copy is a little longer."),
		},
		expect: ["via exa", "a little longer", "Short page."],
	},
	{
		name: "a thin page names why the other sources gave nothing",
		url: "https://tiny.example/",
		withExaKey: true,
		routes: {
			"GET https://tiny.example/": markdown("# Tiny\n\nShort."),
			"POST https://api.exa.ai/contents": () => new Response("", { status: 400 }),
		},
		expect: ["via direct", "Short page.", "Other sources: exa: "],
	},
	{
		name: "an error answer from the page's own host tells more than a third-party API that never answered",
		url: "https://news.ycombinator.com/item?id=7",
		routes: {
			"GET https://hn.algolia.com/api/v1/items/7": dropsMidBody,
			"GET https://news.ycombinator.com/item?id=7": () => new Response("", { status: 503 }),
		},
		expect: ["bad-answer: hacker-news: ", "direct: https://news.ycombinator.com/item?id=7 answered HTTP 503"],
	},
	{
		name: "a host that never answers is unreachable, and its URL is not sent to Exa",
		url: "https://intranet.example/",
		withExaKey: true,
		routes: { "GET https://intranet.example/": dropsMidBody },
		expect: ["unreachable: direct: "],
		absent: ["agent-browser"],
	},
	{
		name: "a redirect from Exa to another host is not followed, so the key never leaves Exa",
		url: "https://docs.example/broken",
		withExaKey: true,
		routes: {
			"GET https://docs.example/broken": () => new Response("", { status: 500 }),
			"POST https://api.exa.ai/contents": redirect("https://collector.example/"),
			"GET https://collector.example/": (_body, headers) =>
				Response.json({
					results: [
						{
							url: "https://docs.example/broken",
							text: `key ${headers["x-api-key"] ?? "none"} ${prose("Leak")}`,
						},
					],
				}),
		},
		expect: ["exa: "],
		absent: ["test-key", "via exa"],
	},
	{
		name: "an Exa answer over 25 MB is refused",
		url: "https://docs.example/broken",
		withExaKey: true,
		routes: {
			"GET https://docs.example/broken": () => new Response("", { status: 500 }),
			"POST https://api.exa.ai/contents": plain(Str.repeat(26 * 1024 * 1024)("x")),
		},
		expect: ["https://api.exa.ai/contents is over 25 MB"],
	},
	{
		name: "a signed URL is never sent to Exa",
		url: "https://bucket.example/report.pdf?X-Amz-Signature=abc&X-Amz-Expires=60",
		withExaKey: true,
		routes: {
			"GET https://bucket.example/report.pdf?X-Amz-Signature=abc&X-Amz-Expires=60": () =>
				new Response("", { status: 403 }),
		},
		expect: [
			"bad-answer: direct: https://bucket.example/report.pdf?X-Amz-Signature=abc&X-Amz-Expires=60 answered HTTP 403.",
		],
	},
	{
		name: "a 404 is not read from Exa's copy",
		url: "https://docs.example/old",
		withExaKey: true,
		routes: { "GET https://docs.example/old": missing },
		expect: ["gone: https://docs.example/old answered HTTP 404"],
	},
];

readRows(rows);
