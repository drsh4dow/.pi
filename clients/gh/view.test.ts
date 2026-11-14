import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { type Checks, type PrView, viewOf } from "./view.ts";

const reviewed = `{"headRefOid":"9c1e2a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reviewDecision":"CHANGES_REQUESTED","state":"OPEN","url":"https://github.com/o/r/pull/7","reviews":[{"id":"PRR_x","author":{"login":"review-bot"},"authorAssociation":"NONE","body":"...","submittedAt":"2026-11-14T12:07:09Z","includesCommitData":true,"state":"CHANGES_REQUESTED"},{"id":"PRR_y","author":{"login":"drsh4dow"},"submittedAt":"","state":"PENDING"}],"statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-11-14T12:20:58Z","conclusion":"NEUTRAL","detailsUrl":"https://example.invalid","name":"lint","startedAt":"2026-11-14T12:20:58Z","status":"COMPLETED","workflowName":""}]}`;

interface Bare {
	readonly rollup?: ReadonlyArray<string>;
	readonly state?: string;
	readonly url?: string;
}

/** The output gh gives for an open pull request with no decision, no reviews and the given rollup entries. */
const bare = ({ rollup = [], state = "OPEN", url = "https://github.com/drsh4dow/pi-gate-scratch/pull/1" }: Bare) =>
	`{"headRefOid":"02732a55f571c4f41c80be807b0e5f1bc21dc669","reviewDecision":"","reviews":[],"statusCheckRollup":[${Arr.join(rollup, ",")}],"state":"${state}","url":"${url}"}`;

test("a reviewed pull request reads with its ref, decision and submitted reviews only", () => {
	const expected: PrView = {
		ref: "o/r#7",
		head: "9c1e2a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		reviewDecision: Option.some("CHANGES_REQUESTED"),
		reviews: [{ author: "review-bot", state: "CHANGES_REQUESTED", submittedAt: "2026-11-14T12:07:09Z" }],
		checks: "pass",
		state: "OPEN",
	};

	expect(viewOf(reviewed)).toEqual(Result.succeed(expected));
});

test("an empty decision reads as none", () => {
	const decision = viewOf(bare({})).pipe(Result.map((view) => view.reviewDecision));

	expect(decision).toEqual(Result.succeed(Option.none()));
});

const run = (status: string, conclusion: string) =>
	`{"__typename":"CheckRun","status":"${status}","conclusion":"${conclusion}"}`;

const context = (state: string) => `{"__typename":"StatusContext","state":"${state}"}`;

const passed = run("COMPLETED", "SUCCESS");

const rollups: ReadonlyArray<{
	readonly name: string;
	readonly rollup: ReadonlyArray<string>;
	readonly expect: Checks;
}> = [
	{ name: "no checks", rollup: [], expect: "none" },
	{
		name: "success, neutral and skipped runs",
		rollup: [passed, run("COMPLETED", "NEUTRAL"), run("COMPLETED", "SKIPPED")],
		expect: "pass",
	},
	{ name: "a queued run", rollup: [passed, run("QUEUED", "")], expect: "pending" },
	{ name: "an in-progress run", rollup: [run("IN_PROGRESS", "")], expect: "pending" },
	{
		name: "a failed run beside a pending one",
		rollup: [run("IN_PROGRESS", ""), run("COMPLETED", "FAILURE")],
		expect: "fail",
	},
	{ name: "a timed-out run", rollup: [passed, run("COMPLETED", "TIMED_OUT")], expect: "fail" },
	{ name: "a cancelled run", rollup: [run("COMPLETED", "CANCELLED")], expect: "fail" },
	{ name: "a run that needs action", rollup: [run("COMPLETED", "ACTION_REQUIRED")], expect: "fail" },
	{ name: "a run that failed to start", rollup: [run("COMPLETED", "STARTUP_FAILURE")], expect: "fail" },
	{ name: "a successful status", rollup: [context("SUCCESS")], expect: "pass" },
	{ name: "a failed status", rollup: [passed, context("FAILURE")], expect: "fail" },
	{ name: "an errored status", rollup: [context("ERROR")], expect: "fail" },
	{ name: "a pending status", rollup: [passed, context("PENDING")], expect: "pending" },
	{ name: "an expected status", rollup: [context("EXPECTED")], expect: "pending" },
];

for (const row of rollups) {
	test(`${row.name} read as checks ${row.expect}`, () => {
		const checks = viewOf(bare({ rollup: row.rollup })).pipe(Result.map((view) => view.checks));

		expect(checks).toEqual(Result.succeed(row.expect));
	});
}

const unreadable = [
	{ name: "text that is not JSON", stdout: "Could not resolve" },
	{ name: "an unknown state", stdout: bare({ state: "DRAFT" }) },
	{ name: "a url that is not a pull request's", stdout: bare({ url: "https://github.com/o/r" }) },
];

for (const row of unreadable) {
	test(`${row.name} does not read`, () => {
		expect(viewOf(row.stdout).pipe(Result.isFailure)).toBe(true);
	});
}
