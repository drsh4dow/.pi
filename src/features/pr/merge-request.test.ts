import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { MergeRequest, mergeRequestOf } from "./merge-request.ts";

const summary = (argv: ReadonlyArray<string>) =>
	Option.match(mergeRequestOf(argv), {
		onNone: () => "passes through",
		onSome: MergeRequest.$match({
			Merge: ({ pr }) => `merge ${pr}`,
			StackMerge: ({ ceiling }) => `stack merge up to ${ceiling}`,
			Refuse: ({ why }) => `refuse: ${Arr.headNonEmpty(Str.split(why, "\n"))}`,
		}),
	});

const scratchPr = "https://github.com/o/r/pull/5";

const rows: ReadonlyArray<{ readonly argv: ReadonlyArray<string>; readonly expect: string }> = [
	{ argv: ["pr", "merge", "5", "--squash"], expect: "merge 5" },
	{ argv: ["pr", "merge", "5", "-R", "o/r", "--squash"], expect: `merge ${scratchPr}` },
	{ argv: ["-R", "o/r", "pr", "merge", "5", "--squash"], expect: `merge ${scratchPr}` },
	{ argv: ["pr", "merge", "--repo=o/r", "5"], expect: `merge ${scratchPr}` },
	{ argv: ["pr", "merge", "-R", "ghe.example/o/r", "5"], expect: "merge https://ghe.example/o/r/pull/5" },
	{ argv: ["pr", "merge", "-b", "merge it", "5", "--admin"], expect: "merge 5" },
	{ argv: ["pr", "merge", scratchPr, "--squash"], expect: `merge ${scratchPr}` },
	{ argv: ["pr", "merge", "-Ro/r", "5"], expect: `merge ${scratchPr}` },
	{
		argv: ["pr", "merge", "topic", "-R", "o/r", "--squash"],
		expect:
			"refuse: merge gate: with -R, name the pull request by number or URL, as in `gh pr merge <number> -R <owner/repo> --squash`.",
	},
	{ argv: ["pr", "merge", "5", "--squash", "--disable-auto=0"], expect: "merge 5" },
	{
		argv: ["pr", "merge", "--squash"],
		expect: "refuse: merge gate: name the pull request, as in `gh pr merge <number> --squash`.",
	},
	{ argv: ["pr", "merge", "5", "--auto", "--squash"], expect: "refuse: merge gate: a deferred merge is refused." },
	{ argv: ["pr", "merge", "5", "--auto=false", "--squash"], expect: "merge 5" },
	{ argv: ["pr", "merge", "5", "--disable-auto"], expect: "passes through" },
	{ argv: ["stack", "merge", "7", "--yes", "--squash"], expect: "stack merge up to 7" },
	{
		argv: ["stack", "merge", "--yes"],
		expect: "refuse: merge gate: name the ceiling by number, as in `gh stack merge <number> --yes --squash`.",
	},
	...Arr.map(
		[
			["api", "-X", "PUT", "repos/o/r/pulls/5/merge"],
			["api", "repos/o/r/pulls/5/merge"],
			["api", "--method=put", "/repos/{owner}/{repo}/pulls/5/merge"],
			["api", "-X", "PUT", "https://api.github.com/repos/o/r/pulls/5/merge"],
			["api", "-X", "PUT", "https://API.GITHUB.COM/repos/o/r/pulls/5/merge"],
			["api", "-X", "PUT", "https://api.github.com:443/repos/o/r/pulls/5/merge"],
			["api", "-X", "PUT", "http://api.github.com/repos/o/r/pulls/5/merge"],
			["api", "-X", "PUT", "repos/o/r/pulls/5/merge?merge_method=squash"],
			["api", "-X", "PUT", "repos/o/r/pulls/5/merge#x"],
			["api", "-X", "PUT", "//repos/o/r/pulls/5/merge"],
			["api", "-X", "PUT", "repositories/123/pulls/5/merge"],
			[
				"api",
				"graphql",
				"-f",
				'query=mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId } }',
			],
			[
				"api",
				"https://API.GITHUB.COM/graphql",
				"-f",
				"query=mutation { mergePullRequest(input: {}) { clientMutationId } }",
			],
		],
		(argv) => ({ argv, expect: "refuse: merge gate: the gate does not merge through `gh api`." }),
	),
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
	{
		argv: [
			"api",
			"graphql",
			"-f",
			'query={ repository(owner: "o", name: "r") { pullRequest(number: 5) { mergeable mergeStateStatus } } }',
		],
		expect: "passes through",
	},
	{ argv: ["pr", "view", "5"], expect: "passes through" },
	{ argv: ["pr", "view", "merge-fix"], expect: "passes through" },
	{ argv: ["pr", "list", "--search", "merge"], expect: "passes through" },
];

const calls = Arr.map(rows, (row) => ({ ...row, command: Arr.join(row.argv, " ") }));

test.each(calls)("gh $command $expect", (row) => {
	expect(summary(row.argv)).toBe(row.expect);
});

test("a deferred merge's refusal names a merge in the repository the call named", () => {
	const why = Option.match(mergeRequestOf(["pr", "merge", "5", "-R", "o/r", "--auto", "--squash"]), {
		onNone: () => "",
		onSome: MergeRequest.$match({ Merge: () => "", StackMerge: () => "", Refuse: (refusal) => refusal.why }),
	});

	expect(why).toContain("`gh pr checks 5 -R o/r --watch`");
	expect(why).toContain("`gh pr merge 5 -R o/r --squash`");
});

test("every call the parser does not pass through names merge, which is all the gh wrapper looks for", () => {
	const gated = Arr.filter(rows, (row) => row.expect !== "passes through");

	expect(Arr.filter(gated, (row) => !/merge/iu.test(Arr.join(row.argv, " ")))).toEqual([]);
});
