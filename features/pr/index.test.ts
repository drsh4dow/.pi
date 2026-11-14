import { expect, test } from "bun:test";

import type * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import { Gh, GhError, type PrView } from "../../clients/gh/index.ts";
import { changes, pin, prWait } from "./index.ts";

const open: PrView = {
	repo: "o/r",
	number: 1,
	ref: "o/r#1",
	head: "9c1e2a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	reviewDecision: Option.none(),
	reviews: [{ author: "bot", state: "COMMENTED", submittedAt: "2026-11-14T12:00:00Z" }],
	checks: "pending",
	state: "OPEN",
};

const octoApproved = { author: "octo", state: "APPROVED", submittedAt: "2026-11-14T13:00:00Z" };

const changeRows: ReadonlyArray<{
	readonly name: string;
	readonly before?: PrView;
	readonly after: PrView;
	readonly expect: ReadonlyArray<string>;
}> = [
	{ name: "an identical reading", after: open, expect: [] },
	{
		name: "a new head",
		after: { ...open, head: "4b7d113bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
		expect: ["head 9c1e2a0 -> 4b7d113"],
	},
	{
		name: "a new head that shares the short sha",
		after: { ...open, head: "9c1e2a0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
		expect: ["head 9c1e2a0 -> 9c1e2a0"],
	},
	{
		name: "a first decision",
		after: { ...open, reviewDecision: Option.some("APPROVED") },
		expect: ["review decision none -> APPROVED"],
	},
	{
		name: "a new review",
		after: { ...open, reviews: [...open.reviews, octoApproved] },
		expect: ["review by octo: APPROVED"],
	},
	{
		name: "a changed decision",
		before: { ...open, reviewDecision: Option.some("APPROVED") },
		after: { ...open, reviewDecision: Option.some("CHANGES_REQUESTED") },
		expect: ["review decision APPROVED -> CHANGES_REQUESTED"],
	},
	{
		name: "a dismissed review",
		before: { ...open, reviews: [octoApproved] },
		after: { ...open, reviews: [{ ...octoApproved, state: "DISMISSED" }] },
		expect: ["review by octo: DISMISSED"],
	},
	{ name: "new checks", after: { ...open, checks: "pass" }, expect: ["checks pending -> pass"] },
	{ name: "a merge", after: { ...open, state: "MERGED" }, expect: ["state OPEN -> MERGED"] },
];

for (const row of changeRows) {
	test(`changes after ${row.name}`, () => {
		expect(changes({ before: row.before ?? open, after: row.after })).toEqual(row.expect);
	});
}

type Reading = Effect.Effect<PrView, GhError>;

const failed = (why: string) => Effect.fail(GhError.make({ args: ["pr", "view"], why }));

const scripted = (scripts: Readonly<Record<string, ReadonlyArray<Reading>>>) => {
	const reads = new Map<string, number>();

	const view = (pr: string) =>
		Effect.suspend(() => {
			const script = scripts[pr] ?? [];
			const read = reads.get(pr) ?? 0;

			reads.set(pr, read + 1);

			return script[Math.min(read, script.length - 1)] ?? failed(`no script for ${pr}`);
		});

	return Layer.succeed(Gh, Gh.of({ view, patchId: () => Effect.succeed("6499691") }));
};

const outcome = (prs: Arr.NonEmptyReadonlyArray<string>) =>
	Effect.gen(function* () {
		const result = yield* Effect.result(prWait(prs));
		const seconds = (yield* Clock.currentTimeMillis) / 1000;

		return Result.match(result, {
			onSuccess: (lines) => ({ lines, seconds }),
			onFailure: (error) => ({ failed: error.why, seconds }),
		});
	});

const waited = (prs: Arr.NonEmptyReadonlyArray<string>) =>
	Effect.gen(function* () {
		const waiting = yield* Effect.forkChild(outcome(prs));

		yield* TestClock.adjust("1 hour");

		return yield* Fiber.join(waiting);
	});

const first = Effect.succeed(open);

const second = Effect.succeed({ ...open, ref: "o/r#2" });

const secondPushed = Effect.succeed({ ...open, ref: "o/r#2", head: "4b7d113bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });

const pushed = Effect.succeed({ ...open, head: "4b7d113bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });

const loopRows = [
	{
		name: "names only the pull request that changed",
		prs: ["1", "2"],
		scripts: { "1": [first], "2": [second, second, secondPushed] },
		expect: { lines: ["o/r#2 head 9c1e2a0 -> 4b7d113"], seconds: 120 },
	},
	{
		name: "fails at once when a first reading fails",
		prs: ["1", "2"],
		scripts: { "1": [first], "2": [failed("no pull request 2"), second] },
		expect: { failed: "no pull request 2", seconds: 0 },
	},
	{
		name: "ends at once on a pull request merged at the first reading",
		prs: ["1", "2"],
		scripts: { "1": [first], "2": [Effect.succeed({ ...open, ref: "o/r#2", state: "MERGED" as const })] },
		expect: { lines: ["o/r#2 state MERGED"], seconds: 0 },
	},
	{
		name: "ends at once on a pull request closed at the first reading",
		prs: ["1"],
		scripts: { "1": [Effect.succeed({ ...open, state: "CLOSED" as const })] },
		expect: { lines: ["o/r#1 state CLOSED"], seconds: 0 },
	},
	{
		name: "rides out two failed rounds",
		prs: ["1"],
		scripts: { "1": [first, failed("down"), failed("down"), pushed] },
		expect: { lines: ["o/r#1 head 9c1e2a0 -> 4b7d113"], seconds: 180 },
	},
	{
		name: "fails on the third failed round in a row",
		prs: ["1"],
		scripts: { "1": [first, failed("down 1"), failed("down 2"), failed("down 3"), pushed] },
		expect: { failed: "down 3", seconds: 180 },
	},
	{
		name: "counts failed rounds again after a good one",
		prs: ["1"],
		scripts: { "1": [first, failed("down"), failed("down"), first, failed("down"), failed("down"), pushed] },
		expect: { lines: ["o/r#1 head 9c1e2a0 -> 4b7d113"], seconds: 360 },
	},
] as const;

for (const row of loopRows) {
	test(`prWait ${row.name}`, () => {
		const layer = Layer.merge(scripted(row.scripts), TestClock.layer());

		const check = Effect.gen(function* () {
			const got = yield* waited(row.prs);

			expect(got).toEqual(row.expect);
		});

		return Effect.runPromise(Effect.provide(check, layer));
	});
}

test("a pin whose head moves while it reads the diff refuses, naming both heads", () => {
	const moved = { ...open, head: "4b7d113bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
	const layer = scripted({ "1": [Effect.succeed(open), Effect.succeed(moved)] });

	const check = Effect.gen(function* () {
		const { why } = yield* Effect.flip(pin("1"));

		expect(why).toBe(
			`its head moved from ${open.head} to ${moved.head} while it was pinned, so start the verifier again`,
		);
	});

	return Effect.runPromise(Effect.provide(check, layer));
});
