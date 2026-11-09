import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { Body, PublicUrl } from "../../clients/web/index.ts";
import { fetchReply } from "./view.ts";

const url = PublicUrl.make("https://docs.example/");

const savedAs = (text: string) =>
	({
		page: {
			url,
			finalUrl: url,
			title: Option.none(),
			via: "direct",
			caveat: Option.none(),
			body: Body.Markdown({ text }),
		},
		saved: { markdown: Option.some({ path: "/cache/page.md", text }), file: Option.none() },
	}) as const;

const rows = [
	{
		name: "a long line right after lines that fill 30 KB exactly is not shown, and its bash command starts at byte 1",
		text: `${Str.repeat(30 * 1024)("a")}\n${Str.repeat(40_000)("b")}`,
		expect: ["Line 2 is over 30 KB", 'sed -n 2p "/cache/page.md" | cut -b 1-30720'],
		absent: ["bb", "Then continue"],
	},
	{
		name: "a long line cut inside a two-byte character says to read on from the first byte not shown",
		text: `hh${Str.repeat(20_000)("é")}`,
		expect: ["cut -b 30719-61438"],
		absent: [],
	},
	{
		name: "a long line with lines after it also says where read picks up",
		text: `a\n${Str.repeat(40_000)("b")}\nc\nd`,
		expect: ["Line 2 is over 30 KB", 'Then continue with read(path: "/cache/page.md", offset: 3).'],
		absent: [],
	},
];

for (const { name, text, expect: wanted, absent } of rows) {
	test(name, () => {
		const got = fetchReply(savedAs(text)).text;

		expect({
			lacking: Arr.filter(wanted, (part) => !Str.includes(part)(got)),
			unwanted: Arr.filter(absent, (part) => Str.includes(part)(got)),
		}).toEqual({ lacking: [], unwanted: [] });
	});
}
