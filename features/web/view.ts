import type { JsonValue } from "@earendil-works/pi-ai";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { Hits, Page } from "../../clients/web/index.ts";
import type { Saved, SavedFile } from "./store.ts";

export interface SavedPage {
	readonly page: Page;
	readonly saved: Saved;
}

const inlineBudget = { maxBytes: 30 * 1024, maxLines: 2000 };

interface Slice {
	readonly text: string;
	readonly shown: number;
	readonly total: number;
	readonly longLine: Option.Option<{ readonly lineNumber: number; readonly bytesShown: number }>;
}

const byteHead = (line: string, bytes: number) =>
	new TextDecoder().decode(new TextEncoder().encode(line).subarray(0, bytes), { stream: true });

const sliceOf = (text: string): Slice => {
	const { content, outputLines, outputBytes, totalLines } = truncateHead(text, inlineBudget);
	const next = Str.split(text, "\n")[outputLines] ?? "";
	const slice = { text: content, shown: outputLines, total: totalLines, longLine: Option.none() };

	if (Buffer.byteLength(next) <= inlineBudget.maxBytes) {
		return slice;
	}

	const bytes = Math.max(0, inlineBudget.maxBytes - outputBytes - 1);
	const head = byteHead(next, bytes);

	return {
		...slice,
		text: Arr.join(Arr.filter([content, head], Str.isNonEmpty), "\n"),
		longLine: Option.some({ lineNumber: outputLines + 1, bytesShown: Buffer.byteLength(head) }),
	};
};

const defuseClosingTag = Str.replaceAll(/<\s*\/\s*web_content/giu, "</web_content_");

const wrapped = (page: Page, text: string) =>
	`<web_content url="${page.finalUrl}" via="${page.via}" trust="untrusted">\n${defuseClosingTag(text)}\n</web_content>`;

const readNote = (path: string, { shown, total }: Slice) =>
	shown < total
		? `Showing lines 1-${String(shown)} of ${String(total)}. Continue with read(path: "${path}", offset: ${String(shown + 1)}).`
		: `This is all of it (${String(total)} lines).`;

const bashNote = (path: string, lineNumber: number, bytesShown: number) =>
	`Line ${String(lineNumber)} is over 30 KB, so only its first ${formatSize(bytesShown)} is shown, and pi's read refuses lines over 50 KB. Read on with bash, such as: sed -n ${String(lineNumber)}p "${path}" | cut -b ${String(bytesShown + 1)}-${String(bytesShown + inlineBudget.maxBytes)}`;

const afterLongLine = (path: string, lineNumber: number, total: number) =>
	lineNumber < total ? ` Then continue with read(path: "${path}", offset: ${String(lineNumber + 1)}).` : "";

const linesNote = (path: string, slice: Slice) =>
	Option.match(slice.longLine, {
		onNone: () => readNote(path, slice),
		onSome: ({ lineNumber, bytesShown }) =>
			`${bashNote(path, lineNumber, bytesShown)}${afterLongLine(path, lineNumber, slice.total)}`,
	});

const fileNote = ({ path, mime, bytes }: SavedFile) => `Saved ${mime} (${formatSize(bytes)}): ${path}.`;

export const fetchReply = ({ page, saved }: SavedPage) => {
	const file = Option.map(saved.file, fileNote);
	const markdown = Option.map(saved.markdown, ({ path, text }) => ({ path, slice: sliceOf(text) }));

	const body = Option.match(markdown, {
		onNone: () => ["No text was extracted. Open the file with a tool that reads its type."],
		onSome: ({ path, slice }) => {
			const where = Option.isSome(file) ? `Markdown of it: ${path}.` : `Saved: ${path}.`;

			return [wrapped(page, slice.text), `${where} ${linesNote(path, slice)}`];
		},
	});

	const json = {
		url: page.url,
		final_url: page.finalUrl,
		via: page.via,
		...Option.match(page.title, { onNone: () => ({}), onSome: (title) => ({ title }) }),
		...Option.match(page.caveat, { onNone: () => ({}), onSome: (caveat) => ({ caveat }) }),
		...Option.match(saved.file, { onNone: () => ({}), onSome: (found) => ({ file: { ...found } }) }),
		...Option.match(markdown, {
			onNone: () => ({}),
			onSome: ({ path, slice }) => ({
				markdown: path,
				lines: { shown: slice.shown, total: slice.total },
				text: slice.text,
			}),
		}),
		untrusted: true,
	} satisfies JsonValue;

	return { text: Arr.join([...Option.toArray(file), ...body, ...Option.toArray(page.caveat)], "\n"), json };
};

export const hitsJson = ({ provider, costUsd, hits }: Hits): JsonValue => ({
	provider,
	...Option.match(costUsd, { onNone: () => ({}), onSome: (cost) => ({ cost_usd: cost }) }),
	results: Arr.map(hits, ({ title, url, published, highlights }) => ({
		title,
		url,
		...Option.match(published, { onNone: () => ({}), onSome: (date) => ({ published: date }) }),
		highlight: Str.takeLeft(Arr.join(highlights, " … "), 300),
	})),
});
