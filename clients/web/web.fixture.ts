import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { exaLayerWith } from "../exa/index.ts";
import { type Page, PublicUrl, Web, webLayerWith } from "./index.ts";
import { fakeTransport, type Routes } from "./transport.fixture.ts";

export interface Row {
	readonly name: string;
	readonly routes: Routes;
	readonly expect: ReadonlyArray<string>;
	readonly absent?: ReadonlyArray<string>;
	readonly withExaKey?: boolean;
}

export interface ReadRow extends Row {
	readonly url: string;
}

const exaKey = (withExaKey: boolean) =>
	exaLayerWith(withExaKey ? Option.some(Redacted.make("test-key")) : Option.none());

const missingParts = (got: string, row: Row) => ({
	lacking: Arr.filter(row.expect, (part) => !Str.includes(part)(got)),
	unwanted: Arr.filter(row.absent ?? [], (part) => Str.includes(part)(got)),
});

export const webFor = ({ routes, withExaKey }: Pick<Row, "routes" | "withExaKey">) =>
	webLayerWith({ transport: fakeTransport(routes), exa: exaKey(withExaKey ?? false) });

export const checkEach =
	<Case extends Row>(outcome: (row: Case) => Effect.Effect<string, never, Web>) =>
	(rows: ReadonlyArray<Case>) => {
		for (const row of rows) {
			const layer = webFor(row);

			const check = Effect.map(outcome(row), (got) => {
				expect(missingParts(got, row)).toEqual({ lacking: [], unwanted: [] });
			});

			test(row.name, () => Effect.runPromise(Effect.provide(check, layer)));
		}
	};

const bodyView = (page: Page) =>
	Match.valueTags(page.body, {
		Markdown: ({ text }) => text,
		File: ({ mime, bytes, markdown: text }) =>
			`${mime} ${String(bytes.length)} bytes\n${Option.getOrElse(text, () => "no markdown")}`,
	});

const view = (page: Page) =>
	Arr.join(
		[
			`via ${page.via}`,
			`final ${page.finalUrl}`,
			`title ${Option.getOrElse(page.title, () => "-")}`,
			...Option.toArray(page.caveat),
			bodyView(page),
		],
		"\n",
	);

export const readOutcome = (url: string) =>
	Schema.decodeEffect(PublicUrl)(url).pipe(
		Effect.orDie,
		Effect.flatMap((target) => Effect.flatMap(Web, (web) => web.read(target))),
		Effect.match({ onFailure: ({ kind, message }) => `${kind}: ${message}`, onSuccess: view }),
	);

export const readRows = checkEach((row: ReadRow) => readOutcome(row.url));
