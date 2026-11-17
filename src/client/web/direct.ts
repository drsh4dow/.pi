import { Defuddle, type DefuddleOptions } from "defuddle/node";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { extractText, getDocumentProxy } from "unpdf";

import { fetched } from "./guard.ts";
import { Body, type Found, type Source, WebError } from "./page.ts";
import { type Fetched, textOf } from "./text.ts";

type Kind = "markdown" | "html" | "pdf" | "text" | "file";

const kinds: ReadonlyArray<readonly [Kind, RegExp]> = [
	["markdown", /^text\/(?:x-)?markdown$/u],
	["html", /^(?:text\/html|application\/xhtml\+xml)$/u],
	["pdf", /^application\/pdf$/u],
	["text", /^text\/|[+/](?:json|xml|javascript)$/u],
];

const kindOf = (mime: string): Kind =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(kinds, ([, pattern]) => pattern.test(mime)),
			([kind]) => kind,
		),
		(): Kind => "file",
	);

const headingOf = (markdown: string) =>
	Option.map(Option.fromNullishOr(/^#\s+(?<title>.+)$/mu.exec(markdown)?.groups?.["title"]), Str.trim);

const markdownWith = (options: DefuddleOptions) => (url: string) => (html: string) =>
	Effect.tryPromise({
		// With useAsync on, Defuddle's extractors call third-party APIs, which would go around the guard.
		try: () => Defuddle(html, url, { ...options, markdown: true, useAsync: false }),
		catch: (cause) =>
			WebError.make({ kind: "bad-answer", message: `${url}: HTML did not convert (${String(cause)})` }),
	}).pipe(Effect.map(({ content, title }) => ({ text: content, title: Option.liftPredicate(title, Str.isNonEmpty) })));

const htmlMarkdown = markdownWith({});

/** Thread HTML holds no page chrome, and Defuddle's content patterns would drop each author line above the first long comment as a date byline. */
export const threadMarkdown = markdownWith({ removeContentPatterns: false });

const pageMark = (page: string, index: number) => `<!-- page ${String(index + 1)} -->\n${page}`;

const pdfToMarkdown = (bytes: Uint8Array) =>
	// The pdf.js in unpdf detaches the buffer it is given, so it gets a copy and the saved file keeps the bytes.
	Effect.tryPromise({ try: () => getDocumentProxy(new Uint8Array(bytes)), catch: () => "not a readable PDF" }).pipe(
		Effect.flatMap((pdf) =>
			Effect.tryPromise({ try: () => extractText(pdf, { mergePages: false }), catch: () => "no text layer" }),
		),
		Effect.map(({ text }) => Arr.join(Arr.map(text, pageMark), "\n\n")),
		Effect.option,
	);

const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";

const kindOfPage = ({ mime, bytes }: Fetched): Kind => {
	const kind = kindOf(mime);

	return kind === "file" && isPdf(bytes) ? "pdf" : kind;
};

/** Defuddle takes about 0.3 s and 75 MB per MB of HTML, so a larger page is cut first. */
const htmlCap = 2 * 1024 * 1024;

const htmlCut = "Only the first 2 MB of this page's HTML was converted.";

export const pageOf = (page: Fetched): Effect.Effect<Found, WebError> => {
	const found = (body: Body, title: Option.Option<string>, caveat = Option.none<string>()): Found => ({
		finalUrl: page.finalUrl,
		title,
		caveat,
		body,
	});

	const file = (mime: string) => (markdown: Option.Option<string>) =>
		found(Body.File({ bytes: page.bytes, mime, markdown }), Option.none());

	const html = () => {
		const cut = page.bytes.length > htmlCap;
		const head = textOf({ ...page, bytes: page.bytes.subarray(0, htmlCap) });

		return Effect.map(htmlMarkdown(page.finalUrl)(head), ({ text, title }) =>
			found(Body.Markdown({ text }), title, cut ? Option.some(htmlCut) : Option.none()),
		);
	};

	return Match.value(kindOfPage(page)).pipe(
		Match.when("html", html),
		Match.when("pdf", () => Effect.map(pdfToMarkdown(page.bytes), file("application/pdf"))),
		Match.when("file", () => Effect.sync(() => file(page.mime || "application/octet-stream")(Option.none()))),
		Match.orElse(() => {
			const text = textOf(page);

			return Effect.succeed(found(Body.Markdown({ text }), headingOf(text)));
		}),
	);
};

// Next.js docs and Cloudflare answer Accept: text/markdown with markdown; Mintlify and Bun publish it at <path>.md, where an SPA catch-all answers HTML instead.
const accept = { accept: "text/markdown, text/html;q=0.9, */*;q=0.8" };

const siblingOf = (url: string) => {
	const sibling = new URL(url);

	if (sibling.pathname === "/" || Str.endsWith(".md")(sibling.pathname)) {
		return Option.none();
	}

	sibling.pathname = `${Str.replace(/\/$/u, "")(sibling.pathname)}.md`;
	sibling.search = "";
	sibling.hash = "";

	return Option.some(sibling.href);
};

const isMarkdownCopy = (page: Fetched) =>
	kindOf(page.mime) === "markdown" || (page.mime === "text/plain" && Str.startsWith("#")(Str.trimStart(textOf(page))));

const markdownSibling = (page: Fetched) =>
	kindOf(page.mime) === "html"
		? Option.match(siblingOf(page.finalUrl), {
				onNone: () => Effect.succeedNone,
				onSome: (url) =>
					fetched(HttpClientRequest.get(url)).pipe(
						Effect.map(Option.liftPredicate(isMarkdownCopy)),
						Effect.orElseSucceed(Option.none),
					),
			})
		: Effect.succeedNone;

const read = (url: URL) =>
	Effect.gen(function* () {
		const first = yield* fetched(HttpClientRequest.get(url.href, { headers: accept }));
		const sibling = yield* markdownSibling(first);
		const page = yield* pageOf(Option.getOrElse(sibling, () => first));

		return Option.some(page);
	});

export const direct = {
	via: "direct",
	skipsVerdict: false,
	claims: () => true,
	read,
} as const satisfies Source<"direct">;
