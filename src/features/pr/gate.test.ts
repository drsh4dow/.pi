import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { Gh, GhError, type PrView, type StackMember } from "#src/client/gh/index.ts";
import { recordVerdict, type VerdictRecord, type VerdictResult } from "#src/client/verdicts/index.ts";
import { Authorization, gate } from "./gate.ts";
import { mergeRequestOf } from "./merge-request.ts";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/merge-gate-test-${String(process.pid)}`;

const headOf = (number: number) => Str.repeat(40)(String(number));

const oldHead = Str.repeat(40)("b");

const viewOf = (number: number): PrView => ({
	repo: "o/r",
	number,
	ref: `o/r#${String(number)}`,
	url: `https://github.com/o/r/pull/${String(number)}`,
	head: headOf(number),
	reviewDecision: Option.none(),
	reviews: [],
	checks: "pass",
	state: "OPEN",
});

const verdict = (number: number, result: VerdictResult, at = headOf(number), patchId = `patch-${String(number)}`) => ({
	repo: "o/r",
	number,
	head: at,
	patchId,
	result,
	verifier: { name: `verify ${String(number)}`, session: `session-${result}-${Str.slice(0, 4)(at)}`, model: "m" },
	answer: "/answers/1.md",
});

interface World {
	readonly views: ReadonlyArray<PrView>;
	readonly verdicts: ReadonlyArray<VerdictRecord>;
	readonly stack?: ReadonlyArray<StackMember>;
}

const failed = (args: ReadonlyArray<string>) => Effect.fail(GhError.make({ args: ["gh", ...args], why: "HTTP 404" }));

const ghOf = ({ views, stack }: World) => {
	const find = (pr: string) => Arr.findFirst(views, (view) => String(view.number) === pr);

	return Layer.succeed(
		Gh,
		Gh.of({
			view: (pr) => Option.match(find(pr), { onNone: () => failed(["pr", "view", pr]), onSome: Effect.succeed }),
			patchId: (pr) => Effect.succeed(`patch-${pr}`),
			stackOf: (ceiling) =>
				stack === undefined ? failed(["api", `repos/{owner}/{repo}/stacks/${ceiling}`]) : Effect.succeed(stack),
		}),
	);
};

const pr5 = viewOf(5);

const rows: ReadonlyArray<{
	readonly name: string;
	readonly argv: ReadonlyArray<string>;
	readonly world: World;
	readonly expect: { readonly pin: ReadonlyArray<string> } | { readonly says: ReadonlyArray<string> };
}> = [
	{
		name: "lets a merge through on a pass at the head, pinned to it",
		argv: ["pr", "merge", "5", "--squash"],
		world: { views: [pr5], verdicts: [verdict(5, "pass")] },
		expect: { pin: ["--match-head-commit", pr5.head] },
	},
	{
		name: "carries a pass with notes from an older head with the same patch",
		argv: ["pr", "merge", "5", "--squash"],
		world: { views: [pr5], verdicts: [verdict(5, "pass+notes", oldHead)] },
		expect: { pin: ["--match-head-commit", pr5.head] },
	},
	{
		name: "refuses a pass at an older head whose patch differs",
		argv: ["pr", "merge", "5", "--squash"],
		world: { views: [pr5], verdicts: [verdict(5, "pass", oldHead, "patch-with-a-space")] },
		expect: { says: ["o/r#5 has no pass at its head 5555555", "- pass by verify 5 at bbbbbbb, another patch."] },
	},
	{
		name: "refuses a fail at the head",
		argv: ["pr", "merge", "5", "--squash"],
		world: { views: [pr5], verdicts: [verdict(5, "fail")] },
		expect: { says: ["Verdicts found:", "- fail by verify 5 at 5555555, this head."] },
	},
	{
		name: "refuses an incomplete verdict at the head",
		argv: ["pr", "merge", "5", "--squash"],
		world: { views: [pr5], verdicts: [verdict(5, "incomplete")] },
		expect: { says: ["- incomplete by verify 5 at 5555555, this head."] },
	},
	{
		name: "refuses changes requested on GitHub over a pass at the head",
		argv: ["pr", "merge", "5", "--squash"],
		world: {
			views: [{ ...pr5, reviewDecision: Option.some("CHANGES_REQUESTED") }],
			verdicts: [verdict(5, "pass")],
		},
		expect: { says: ["o/r#5 has changes requested on GitHub."] },
	},
	{
		name: "refuses a pull request with no verdict, naming the call that fixes it",
		argv: ["pr", "merge", "5", "--squash"],
		world: { views: [pr5], verdicts: [verdict(6, "pass", headOf(5))] },
		expect: {
			says: ["No verdict is recorded for it.", 'with role "leaf" and reviews "https://github.com/o/r/pull/5"'],
		},
	},
	{
		name: "refuses a docs-only merge between work branches with --admin and no verdict",
		argv: ["pr", "merge", "5", "--admin", "--delete-branch"],
		world: { views: [pr5], verdicts: [] },
		expect: { says: ["No verdict is recorded for it."] },
	},
	{
		name: "refuses --auto on a pull request with a pass at its head",
		argv: ["pr", "merge", "5", "--auto", "--squash"],
		world: { views: [pr5], verdicts: [verdict(5, "pass")] },
		expect: { says: ["Wait for the checks with `gh pr checks 5 --watch`"] },
	},
	{
		name: "refuses auto-merge enabled through gh api",
		argv: ["api", "graphql", "-f", "query=mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"],
		world: { views: [pr5], verdicts: [verdict(5, "pass")] },
		expect: { says: ["merge gate: a deferred merge is refused."] },
	},
	{
		name: "refuses a stack merge whose ceiling has a pass and a lower pull request none, naming the lower one",
		argv: ["stack", "merge", "7", "--yes", "--squash"],
		world: {
			views: [viewOf(6), viewOf(7)],
			verdicts: [verdict(7, "pass")],
			stack: [
				{ number: "6", state: "open" },
				{ number: "7", state: "open" },
			],
		},
		expect: { says: ["It lands o/r#6, o/r#7.", "o/r#6 has no pass at its head 6666666"] },
	},
	{
		name: "lets a stack merge through when every open pull request up to the ceiling has a pass",
		argv: ["stack", "merge", "7", "--yes", "--squash"],
		world: {
			views: [viewOf(6), viewOf(7), viewOf(8)],
			verdicts: [verdict(7, "pass")],
			stack: [
				{ number: "6", state: "merged" },
				{ number: "7", state: "open" },
				{ number: "8", state: "open" },
			],
		},
		expect: { pin: [] },
	},
	{
		name: "checks every pull request of a stack merged by its stack number",
		argv: ["stack", "merge", "9", "--yes"],
		world: {
			views: [viewOf(6), viewOf(7)],
			verdicts: [verdict(6, "pass")],
			stack: [
				{ number: "6", state: "open" },
				{ number: "7", state: "open" },
			],
		},
		expect: { says: ["It lands o/r#6, o/r#7.", "o/r#7 has no pass"] },
	},
	{
		name: "refuses a stack merge it cannot enumerate",
		argv: ["stack", "merge", "7", "--yes"],
		world: { views: [viewOf(7)], verdicts: [verdict(7, "pass")] },
		expect: { says: ["could not read what it lands", "stacks/7 failed: HTTP 404"] },
	},
	{
		name: "refuses a merge when it cannot read the pull request",
		argv: ["pr", "merge", "8", "--squash"],
		world: { views: [pr5], verdicts: [] },
		expect: { says: ["gh pr view 8 failed: HTTP 404"] },
	},
];

const whyOf = Authorization.$match({ Allow: () => "allowed", Refuse: ({ why }) => why });

for (const [index, row] of rows.entries()) {
	test(`the merge gate ${row.name}`, () => {
		const root = `${scratch}/${String(index)}`;

		const check = Effect.gen(function* () {
			yield* Effect.forEach(row.world.verdicts, recordVerdict(root));

			const request = Option.getOrThrow(mergeRequestOf(row.argv));
			const authorization = yield* gate(root)(request);

			if ("pin" in row.expect) {
				expect(authorization).toEqual(Authorization.Allow({ pin: row.expect.pin }));
			} else {
				const why = whyOf(authorization);

				for (const line of row.expect.says) {
					expect(why).toContain(line);
				}
			}
		});

		const world = Layer.merge(ghOf(row.world), NodeServices.layer);

		return Effect.runPromise(Effect.provide(check, world));
	});
}

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`.quiet())));
