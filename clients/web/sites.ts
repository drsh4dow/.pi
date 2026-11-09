import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { DOMParser } from "linkedom";

import { type Content, Exa, type ExaError } from "../exa/index.ts";
import { pageOf, threadMarkdown } from "./direct.ts";
import { fetched } from "./guard.ts";
import { Body, type Found, rendered, type Source, unlessGone, WebError } from "./page.ts";
import { decoded, type Fetched, textOf } from "./text.ts";

const got = (url: string) => fetched(HttpClientRequest.get(url));

const escaped = (text: string) =>
	Function.pipe(
		text,
		Str.replaceAll("&", "&amp;"),
		Str.replaceAll("<", "&lt;"),
		Str.replaceAll(">", "&gt;"),
		Str.replaceAll('"', "&quot;"),
	);

const threadDocument = (title: string, body: string) =>
	`<!doctype html><html><head><title>${escaped(title)}</title></head><body><article>${body}</article></body></html>`;

const postHtml = (author: string, date: string, html: string) =>
	`<p><strong>${escaped(author)}</strong>, ${escaped(Str.takeLeft(date, 10))}</p>${html}`;

const threadText = (baseUrl: string, title: string, body: string) =>
	Effect.map(threadMarkdown(baseUrl)(threadDocument(title, body)), ({ text }) => `# ${title}\n\n${text}\n`);

const npmPath = /^\/package\/(?<name>(?:@[^/]+\/)?[^/]+)(?:\/v\/(?<version>[^/]+))?\/?$/u;

const npmHosts: ReadonlySet<string> = new Set(["npmjs.com", "www.npmjs.com"]);

const readmeNames = ["README.md", "readme.md", "Readme.md"];

/** The npmjs.com site answers scripts with a Cloudflare challenge, and the registry's readme field is empty for some large packages such as typescript, so the README file comes from jsDelivr. */
const npmRead = (url: URL) => {
	const groups = npmPath.exec(url.pathname)?.groups;
	const at = `${groups?.["name"] ?? ""}@${groups?.["version"] ?? "latest"}`;
	const tries = Arr.map(readmeNames, (file) => got(`https://cdn.jsdelivr.net/npm/${at}/${file}`));

	return unlessGone(
		Effect.map(Effect.firstSuccessOf(tries), (page) =>
			rendered({ finalUrl: page.finalUrl, title: `${at} README`, text: textOf(page) }),
		),
	);
};

export const npm = {
	via: "npm",
	skipsVerdict: true,
	claims: (url: URL) => npmHosts.has(url.hostname) && npmPath.test(url.pathname),
	read: npmRead,
} as const satisfies Source<"npm">;

interface HnItem {
	readonly author?: string | null;
	readonly created_at: string;
	readonly title?: string | null;
	readonly url?: string | null;
	readonly text?: string | null;
	readonly children: ReadonlyArray<HnItem>;
}

const optionalText = Schema.String.pipe(Schema.NullOr, Schema.optionalKey);

const HnItem = Schema.Struct({
	author: optionalText,
	created_at: Schema.String,
	title: optionalText,
	url: optionalText,
	text: optionalText,
	children: Schema.Array(Schema.suspend((): Schema.Codec<HnItem> => HnItem)),
});

const hnPost = (item: HnItem) => postHtml(item.author ?? "[deleted]", item.created_at, item.text ?? "");

const hnThread = (item: HnItem): string =>
	Arr.isReadonlyArrayNonEmpty(item.children)
		? `${hnPost(item)}<blockquote>${Arr.join(Arr.map(item.children, hnThread), "")}</blockquote>`
		: hnPost(item);

const linkHtml = (link: string) => `<p><a href="${escaped(link)}">${escaped(link)}</a></p>`;

/** Algolia drops flagged items that HN still serves, so its 404 hands the read on, unless HN's own page says there is no such item. */
const hnMissing = (url: URL) =>
	Effect.flatMap(got(url.href), (page) =>
		Str.trim(textOf(page)) === "No such item."
			? Effect.fail(WebError.make({ kind: "gone", message: `${url.href}: Hacker News has no such item.` }))
			: Effect.succeedNone,
	);

const hnRead = (url: URL) =>
	Effect.gen(function* () {
		const id = url.searchParams.get("id") ?? "";
		const item = yield* Effect.flatMap(got(`https://hn.algolia.com/api/v1/items/${id}`), decoded(HnItem));
		const title = item.title ?? `Hacker News item ${id}`;
		const link = Option.getOrElse(Option.map(Option.fromNullishOr(item.url), linkHtml), () => "");
		const comments = Arr.join(Arr.map(item.children, hnThread), "");
		const text = yield* threadText(url.href, title, `${link}${hnPost(item)}<hr>${comments}`);

		return rendered({ finalUrl: url.href, title, text });
	}).pipe(
		Effect.asSome,
		Effect.catchIf(
			(error) => error.kind === "gone",
			() => hnMissing(url),
		),
	);

export const hackerNews = {
	via: "hacker-news",
	skipsVerdict: true,
	claims: (url: URL) =>
		url.hostname === "news.ycombinator.com" &&
		url.pathname === "/item" &&
		/^\d+$/u.test(url.searchParams.get("id") ?? ""),
	read: hnRead,
} as const satisfies Source<"hacker-news">;

const redditCaveat = "Reddit's feed: comments arrive flat, without reply nesting, and a long thread may be cut.";

interface XmlNode {
	readonly textContent: string | null;
	readonly querySelector: (selector: string) => XmlNode | null;
	readonly querySelectorAll: (selector: string) => Iterable<XmlNode>;
}

/** The part of linkedom's DOMParser this file uses. Its own types lean on the DOM lib, which this project leaves out, so they read as any. */
interface XmlParser {
	readonly parseFromString: (xml: string, type: "text/xml") => XmlNode;
}

const xmlParser: XmlParser = new DOMParser();

const entriesOf = (xml: string) =>
	Arr.fromIterable(xmlParser.parseFromString(xml, "text/xml").querySelectorAll("entry"));

const textAt = (scope: XmlNode, selector: string) => scope.querySelector(selector)?.textContent ?? "";

const redditPost = (entry: XmlNode) =>
	postHtml(
		Str.replace(/^\/u\//u, "")(textAt(entry, "author > name")),
		textAt(entry, "updated"),
		textAt(entry, "content"),
	);

const redditRead = (url: URL) => {
	const feed = `https://www.reddit.com${Str.replace(/\/?$/u, "/.rss")(url.pathname)}`;

	return Effect.flatMap(got(feed), (page) => {
		const entries = entriesOf(textOf(page));

		return Option.match(Arr.head(entries), {
			onNone: () => Effect.succeedNone,
			onSome: (first) => {
				const title = textAt(first, "title");

				const posts = Arr.join(Arr.map(entries, redditPost), "<hr>");

				return Effect.map(threadText(feed, title, posts), (text) =>
					Option.some({ ...rendered({ finalUrl: url.href, title, text }), caveat: Option.some(redditCaveat) }),
				);
			},
		});
	});
};

export const reddit = {
	via: "reddit",
	skipsVerdict: true,
	claims: (url: URL) => /(?:^|\.)reddit\.com$/u.test(url.hostname) && Str.includes("/comments/")(url.pathname),
	read: redditRead,
} as const satisfies Source<"reddit">;

/** `#/guide/setup?id=x` names `guide/setup.md` beside the page, and `#/` names `README.md`. */
const docsifyFile = (url: URL) => {
	const route = Str.replace(/\?.*$/u, "")(Str.slice(2)(url.hash));
	const file = route === "" || Str.endsWith("/")(route) ? `${route}README.md` : `${route}.md`;

	return Option.liftPredicate(new URL(file, new URL(".", url)), (target) => target.origin === url.origin);
};

const isNotAppShell = (page: Fetched) => page.mime !== "text/html";

const docsifyCopy = (file: URL) =>
	Effect.flatMap(got(file.href).pipe(unlessGone), (copy) =>
		Option.match(Option.filter(copy, isNotAppShell), {
			onNone: () => Effect.succeedNone,
			onSome: (page) => Effect.asSome(pageOf(page)),
		}),
	);

const docsifyRead = (url: URL) =>
	Option.match(docsifyFile(url), { onNone: () => Effect.succeedNone, onSome: docsifyCopy });

export const docsify = {
	via: "docsify",
	skipsVerdict: true,
	claims: (url: URL) => Str.startsWith("#/")(url.hash),
	read: docsifyRead,
} as const satisfies Source<"docsify">;

const secretWords: ReadonlySet<string> = new Set([
	"token",
	"key",
	"secret",
	"sig",
	"signature",
	"password",
	"auth",
	"session",
	"credential",
	"otp",
	"jwt",
	"pwd",
	"passwd",
	"hmac",
	"ticket",
]);

const secretNames: ReadonlySet<string> = new Set(["code", "expires", "sid"]);

/** Lowercase compounds such as authtoken, sessionid, rlkey (Dropbox) or resourcekey (Drive) that split into no listed word. */
const secretInside =
	/token|secret|passw|passc|passphr|sessid|credential|session|authori[sz]|jwt|(?:api|auth|access|private|client|rl|resource|sign|signing)key|^key\d+$/u;

const wordsOf = (name: string) => Str.split(Str.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/gu, "_")(name), /[-_]/u);

const isSecretName = (name: string) => {
	const lower = Str.toLowerCase(name);

	return (
		secretNames.has(lower) ||
		secretInside.test(lower) ||
		/^x-(?:amz|goog)-/u.test(lower) ||
		Arr.some(wordsOf(name), (word) => secretWords.has(Str.toLowerCase(word)))
	);
};

/** A fragment counts only when it holds key=value pairs, as an OAuth redirect's does; a plain #anchor names a heading. */
const parameterNames = (url: URL) => {
	const fragment = Str.includes("=")(url.hash) ? new URLSearchParams(Str.slice(1)(url.hash)) : new URLSearchParams();

	return Arr.appendAll(Arr.fromIterable(url.searchParams.keys()), Arr.fromIterable(fragment.keys()));
};

const exaCaveat = "Exa copy: links stripped, code may be mangled.";

const exaFailure = ({ message }: ExaError) => WebError.make({ kind: "provider", message });

const exaPage =
	(url: URL) =>
	({ title, text }: Content): Found => ({
		finalUrl: url.href,
		title,
		caveat: Option.some(exaCaveat),
		body: Body.Markdown({ text }),
	});

const exaRead = (url: URL) =>
	Effect.flatMap(Exa, (exa) => exa.contents(Str.replace(/#.*$/su, "")(url.href))).pipe(
		Effect.mapBoth({ onFailure: exaFailure, onSuccess: (copy) => Option.map(copy, exaPage(url)) }),
	);

export const exaContents = {
	via: "exa",
	skipsVerdict: false,
	claims: (url: URL) => !Arr.some(parameterNames(url), isSecretName),
	read: exaRead,
} as const satisfies Source<"exa", Exa>;
