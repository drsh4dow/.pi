import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { type Reading, reportOf } from "./report.ts";

const now = DateTime.makeUnsafe("2026-11-10T16:40:00Z");

const usd = (minor: number) => ({ minor, exponent: 2, currency: "USD" });

const ultraA: Reading = {
	account: "ultra-a",
	via: "usage page",
	outcome: {
		kind: "read",
		meters: [
			{
				kind: "window",
				window: {
					name: "weekly",
					percent: 100,
					resetsAt: Option.some(DateTime.makeUnsafe("2026-11-11T23:00:00Z")),
				},
			},
			{ kind: "extra", spend: { used: usd(0), cap: Option.some(usd(4000)), off: Option.some("out_of_credits") } },
		],
	},
};

const ent: Reading = {
	account: "ent",
	via: "usage page",
	outcome: {
		kind: "read",
		meters: [{ kind: "extra", spend: { used: usd(884_857), cap: Option.some(usd(929_325)), off: Option.none() } }],
	},
};

const opencodeGo: Reading = {
	account: "opencode-go",
	via: "OpenCode Go usage API",
	outcome: {
		kind: "read",
		meters: [
			{
				kind: "window",
				window: {
					name: "5-hour",
					percent: 4.4,
					resetsAt: Option.some(DateTime.makeUnsafe("2026-11-10T17:20:00Z")),
				},
			},
		],
	},
};

const openai: Reading = {
	account: "openai",
	via: "estimate from pi's sessions at list prices",
	outcome: { kind: "read", meters: [{ kind: "estimate", usd: 423.184, replies: 17_955, days: 30 }] },
};

const ultraB: Reading = { account: "ultra-b", via: "probe", outcome: { kind: "unreadable", why: "no answer in 20s" } };

test("prints each account under its source, with names in one column, resets as time left, and money as money", () => {
	const report = reportOf({ now, readings: [ultraA, ent, opencodeGo, openai, ultraB] });

	expect(report).toBe(
		Arr.join(
			[
				"ultra-a · usage page",
				"  weekly        100%  resets in 1d 6h",
				"  extra usage   off (out_of_credits) · $0.00 of $40.00 (0%) this month",
				"ent · usage page",
				"  extra usage   $8,848.57 of $9,293.25 (95%) this month",
				"opencode-go · OpenCode Go usage API",
				"  5-hour          4%  resets in 40m",
				"openai · estimate from pi's sessions at list prices",
				"  last 30 days  $423.18 over 17,955 replies",
				"ultra-b · probe",
				"  can't read: no answer in 20s",
			],
			"\n",
		),
	);
});

test("an account that read but reported nothing says so", () => {
	const empty: Reading = { account: "ent", via: "usage page", outcome: { kind: "read", meters: [] } };

	expect(reportOf({ now, readings: [empty] })).toBe("ent · usage page\n  nothing to report");
});
