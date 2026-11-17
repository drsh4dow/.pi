import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type Block, blockLines, blockOf, Card } from "./card.ts";

const now = DateTime.makeUnsafe("2026-11-10T16:40:00Z");

const usd = (minor: number) => ({ minor, exponent: 2, currency: "USD" });

const inADay = Option.some(DateTime.makeUnsafe("2026-11-11T23:00:00Z"));

/** Shows each color as a tag, so a test can read which color a piece of text got. */
const tagging = {
	fg: (color: string, text: string) => (text === "" ? "" : `<${color}>${text}</>`),
	bold: (text: string) => text,
};

/** Shows no color, so a test can read the layout. */
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const ultraA: Block = {
	account: "ultra-a",
	via: "usage page",
	body: blockOf({
		now,
		outcome: {
			kind: "read",
			meters: [
				{ kind: "window", window: { name: "weekly", percent: 100, resetsAt: inADay } },
				{ kind: "window", window: { name: "weekly · Fable", percent: 10, resetsAt: inADay } },
				{ kind: "extra", spend: { used: usd(0), cap: Option.some(usd(4000)), off: Option.some("out_of_credits") } },
			],
		},
	}),
};

const ent: Block = {
	account: "ent",
	via: "usage page",
	body: blockOf({
		now,
		outcome: {
			kind: "read",
			meters: [{ kind: "extra", spend: { used: usd(884_857), cap: Option.some(usd(929_325)), off: Option.none() } }],
		},
	}),
};

const openai: Block = {
	account: "openai",
	via: "estimate",
	body: blockOf({
		now,
		outcome: { kind: "read", meters: [{ kind: "estimate", usd: 423.184, replies: 17_955, days: 30 }] },
	}),
};

const ultraB: Block = {
	account: "ultra-b",
	via: "probe",
	body: blockOf({ now, outcome: { kind: "unreadable", why: "no answer in 20s" } }),
};

const pending: Block = { account: "opencode-go", via: "OpenCode Go usage API", body: { kind: "reading" } };

test("each account shows its source, then its rows with the names in one column and limits as bars", () => {
	expect(blockLines({ blocks: [ultraA, ent, openai, ultraB, pending], theme: plain })).toEqual([
		"ultra-a  usage page",
		"  weekly          ██████████ 100%  resets in 1d 6h",
		"  weekly · Fable  █░░░░░░░░░  10%  resets in 1d 6h",
		"  extra usage     off (out_of_credits) · $0.00 of $40.00 this month",
		"",
		"ent  usage page",
		"  extra usage     ██████████  95%  $8,848.57 of $9,293.25 this month",
		"",
		"openai  estimate",
		"  last 30 days    $423.18 over 17,955 replies",
		"",
		"ultra-b  probe",
		"  can't read: no answer in 20s",
		"",
		"opencode-go  OpenCode Go usage API",
		"  reading…",
	]);
});

const gauges = (percents: ReadonlyArray<number>): Block => ({
	account: "a",
	via: "v",
	body: {
		kind: "read",
		rows: Arr.map(percents, (percent) => ({ kind: "gauge" as const, name: "w", percent, detail: "" })),
	},
});

test("a limit is green with room left, yellow from 75%, and red from 90%", () => {
	const [, low, high, full] = blockLines({ blocks: [gauges([74, 75, 90])], theme: tagging });

	expect(low).toContain("<success>███████</><dim>░░░</> <success> 74%</>");
	expect(high).toContain("<warning>████████</><dim>░░</> <warning> 75%</>");
	expect(full).toContain("<error>█████████</><dim>░</> <error> 90%</>");
});

test("a failure reads in the error color, and extra usage that is off reads dimmed", () => {
	expect(blockLines({ blocks: [ultraB], theme: tagging })[1]).toBe("  <error>can't read: no answer in 20s</>");
	expect(blockLines({ blocks: [ultraA], theme: tagging })[3]).toBe(
		"  <muted>extra usage   </>  <dim>off (out_of_credits) · $0.00 of $40.00 this month</>",
	);
});

test("a card reads back the same from the JSON the session stores", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const card: Card = { readAt: "Nov 10, 16:40", blocks: [ultraA, ent, openai, ultraB] };
			const json = yield* Schema.encodeEffect(Schema.fromJsonString(Card))(card);
			const back = yield* Schema.decodeEffect(Schema.fromJsonString(Card))(json);

			expect(back).toEqual(card);
		}),
	));
