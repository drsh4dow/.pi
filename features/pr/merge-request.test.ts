import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { MergeRequest, mergeRequestOf } from "./merge-request.ts";

const summary = (argv: ReadonlyArray<string>) =>
	Option.match(mergeRequestOf(argv), {
		onNone: () => "passes through",
		onSome: MergeRequest.$match({
			Merge: ({ pr, via }) => `merge ${pr} via ${via}`,
			StackMerge: ({ ceiling }) => `stack merge up to ${ceiling}`,
			Refuse: ({ why }) => `refuse: ${Arr.headNonEmpty(Str.split(why, "\n"))}`,
		}),
	});

const scratchPr = "https://github.com/o/r/pull/5";

const rows: ReadonlyArray<{ readonly argv: ReadonlyArray<string>; readonly expect: string }> = [
	{ argv: ["pr", "merge", "5", "--squash"], expect: "merge 5 via pr" },
	{ argv: ["pr", "merge", "5", "-R", "o/r", "--squash"], expect: `merge ${scratchPr} via pr` },
	{ argv: ["-R", "o/r", "pr", "merge", "5", "--squash"], expect: `merge ${scratchPr} via pr` },
	{ argv: ["pr", "merge", "--repo=o/r", "5"], expect: `merge ${scratchPr} via pr` },
	{ argv: ["pr", "merge", "-R", "ghe.example/o/r", "5"], expect: "merge https://ghe.example/o/r/pull/5 via pr" },
	{ argv: ["pr", "merge", "-b", "merge it", "5", "--admin"], expect: "merge 5 via pr" },
	{ argv: ["pr", "merge", scratchPr, "--squash"], expect: `merge ${scratchPr} via pr` },
	{
		argv: ["pr", "merge", "--squash"],
		expect: "refuse: merge gate: name the pull request, as in `gh pr merge <number> --squash`.",
	},
	{ argv: ["pr", "merge", "5", "--auto", "--squash"], expect: "refuse: merge gate: a deferred merge is refused." },
	{ argv: ["pr", "merge", "5", "--auto=true"], expect: "refuse: merge gate: a deferred merge is refused." },
	{ argv: ["pr", "merge", "5", "--auto=false", "--squash"], expect: "merge 5 via pr" },
	{ argv: ["pr", "merge", "5", "--disable-auto"], expect: "passes through" },
	{ argv: ["stack", "merge", "7", "--yes", "--squash"], expect: "stack merge up to 7" },
	{
		argv: ["stack", "merge", "--yes"],
		expect: "refuse: merge gate: name the ceiling by number, as in `gh stack merge <number> --yes --squash`.",
	},
	{ argv: ["api", "-X", "PUT", "repos/o/r/pulls/5/merge"], expect: `merge ${scratchPr} via api` },
	{ argv: ["api", "--method=put", "/repos/{owner}/{repo}/pulls/5/merge"], expect: "merge 5 via api" },
	{ argv: ["api", "repos/o/r/pulls/5/merge"], expect: "passes through" },
	{
		argv: [
			"api",
			"graphql",
			"-f",
			'query=mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId } }',
		],
		expect: "refuse: merge gate: a merge through `gh api graphql` is refused, because the gate cannot pin its head.",
	},
	{
		argv: [
			"api",
			"graphql",
			"-F",
			"query=mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }",
		],
		expect: "refuse: merge gate: a deferred merge is refused.",
	},
	{
		argv: ["api", "graphql", "-f", "query=mutation { disablePullRequestAutoMerge(input: {}) { clientMutationId } }"],
		expect: "passes through",
	},
	{ argv: ["pr", "view", "5"], expect: "passes through" },
	{ argv: ["pr", "view", "merge-fix"], expect: "passes through" },
	{ argv: ["pr", "list", "--search", "merge"], expect: "passes through" },
];

for (const row of rows) {
	test(`gh ${Arr.join(row.argv, " ")} ${row.expect}`, () => {
		expect(summary(row.argv)).toBe(row.expect);
	});
}
