import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { Exa } from "../exa/index.ts";
import { direct } from "./direct.ts";
import { github } from "./github.ts";
import { botCheck, type PublicUrl } from "./guard.ts";
import { type Found, type Page, WebError } from "./page.ts";
import { docsify, exaContents, hackerNews, npm, reddit } from "./sites.ts";

const sources = [github, npm, hackerNews, reddit, docsify, direct, exaContents] as const;

export type Via = (typeof sources)[number]["via"];

type Verdict = "good" | "thin" | "bot-check";

const textVerdict = (title: string, text: string): Verdict => {
	if (text.length < 3000 && botCheck.test(`${title}\n${text}`)) {
		return "bot-check";
	}

	return text.length < 500 ? "thin" : "good";
};

const verdictOf = ({ title, body }: Found): Verdict =>
	Match.valueTags(body, {
		File: (): Verdict => "good",
		Markdown: ({ text }) =>
			textVerdict(
				Option.getOrElse(title, () => ""),
				text,
			),
	});

interface Tried {
	readonly thin: Option.Option<Page>;
	readonly kinds: ReadonlyArray<WebError["kind"]>;
	readonly reasons: ReadonlyArray<string>;
}

const endsBeforeExa: ReadonlySet<WebError["kind"]> = new Set(["blocked", "too-large", "gone"]);

const telling: ReadonlyArray<WebError["kind"]> = ["needs-browser", "bad-answer", "unreachable", "provider"];

const shortPage = "Short page. If you expected more, it may need a browser (agent-browser skill).";

const textLength = ({ body }: Page) => Match.valueTags(body, { File: () => 0, Markdown: ({ text }) => text.length });

const longer = (best: Option.Option<Page>, page: Page) =>
	Option.match(best, {
		onNone: () => page,
		onSome: (kept) => (textLength(page) > textLength(kept) ? page : kept),
	});

const failure = ({ kinds, reasons }: Tried) => {
	const kind = Option.getOrElse(
		Arr.findFirst(telling, (each) => Arr.contains(kinds, each)),
		(): WebError["kind"] => "bad-answer",
	);

	const advice = kind === "needs-browser" ? "This page needs a real browser: use the agent-browser skill." : "";

	return WebError.make({ kind, message: Str.trim(`${Arr.join(reasons, "; ")}. ${advice}`) });
};

const settle = (tried: Tried) =>
	Option.match(tried.thin, {
		onSome: (page) => {
			const others = Arr.isReadonlyArrayNonEmpty(tried.reasons)
				? [`Other sources: ${Arr.join(tried.reasons, "; ")}.`]
				: [];

			const caveat = Arr.join([...Option.toArray(page.caveat), shortPage, ...others], " ");

			return Effect.succeed({ ...page, caveat: Option.some(caveat) });
		},
		onNone: () => Effect.fail(failure(tried)),
	});

type Claiming = (typeof sources)[number];

const tryEach =
	(url: PublicUrl, parsed: URL) =>
	(remaining: ReadonlyArray<Claiming>, tried: Tried): Effect.Effect<Page, WebError, HttpClient.HttpClient | Exa> =>
		Arr.match(remaining, {
			onEmpty: () => settle(tried),
			onNonEmpty: ([source, ...rest]) => {
				const noted = (why: string, kinds: ReadonlyArray<WebError["kind"]>): Tried => ({
					...tried,
					kinds: [...tried.kinds, ...kinds],
					reasons: [...tried.reasons, `${source.via}: ${why}`],
				});

				const next = (more: Tried) => tryEach(url, parsed)(rest, more);

				const read: Effect.Effect<Option.Option<Found>, WebError, HttpClient.HttpClient | Exa> = source.read(
					parsed,
				);

				const keepsFromExa = (error: WebError) => source.via === "direct" && error.kind === "unreachable";

				return Effect.matchEffect(read, {
					onFailure: (error) => {
						if (endsBeforeExa.has(error.kind)) {
							return Effect.fail(error);
						}

						const more = noted(error.message, [error.kind]);

						return keepsFromExa(error) ? settle(more) : next(more);
					},
					onSuccess: Option.match({
						onNone: () => next(noted("nothing there", [])),
						onSome: (found) => {
							const page: Page = { ...found, url, via: source.via };

							return Match.value(source.skipsVerdict ? "good" : verdictOf(page)).pipe(
								Match.when("good", () => Effect.succeed(page)),
								Match.when("thin", () => next({ ...tried, thin: Option.some(longer(tried.thin, page)) })),
								Match.when("bot-check", () => next(noted("bot check", ["needs-browser"]))),
								Match.exhaustive,
							);
						},
					}),
				});
			},
		});

export const readPage = (url: PublicUrl): Effect.Effect<Page, WebError, HttpClient.HttpClient | Exa> =>
	Effect.flatMap(Exa, (exa) => {
		const parsed = new URL(url);
		const usable = (source: Claiming) => source.claims(parsed) && (source.via !== "exa" || exa.hasKey);

		return tryEach(url, parsed)(Arr.filter(sources, usable), { thin: Option.none(), kinds: [], reasons: [] });
	});
