import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { actionItemProblems } from "./action-items.ts";

const file = (...lines: ReadonlyArray<string>) => Arr.join(lines, "\n");
const problemLines = (text: string) => Arr.map(actionItemProblems(text), ({ line }) => line);

const messageAt = (text: string, line: number) =>
	Option.map(
		Arr.findFirst(actionItemProblems(text), (problem) => problem.line === line),
		({ message }) => message,
	);

const bulletFields = file(
	"# What the work needs from you",
	"",
	"## 1. Turn on required owner review for `main`",
	"- **The call.** PR 146 names the owners, but nothing enforces a review.",
	"- **My pick.** Ask an admin to run this after PR 146 merges.",
	"  ```bash",
	"  gh api repos/acme/app/rulesets -X POST --input ruleset.json",
	"  ```",
	"- **What it changes.** A PR to the owned paths needs an owner's approval.",
	"- **Risk.** Your own PRs to those paths wait for the other owner.",
	"",
	"## 2. `.github/` is owned too",
	"- **The call.** I added `.github/` so a PR cannot delete `CODEOWNERS` unreviewed.",
	"- **Instead.** Tell me to strike it.",
	"",
	"## 3. The copied skill",
	"- **The call.** Deleting the copy is right only if its engineers start here.",
	"- **My pick.** Ask the engineer who added it.",
	"",
	"## 4. Your agents and `op-approve`",
	"- **The call.** The skill no longer tells agents to run `op-approve`.",
	"- **My pick.** Add one sentence to your setup.",
	"- **Also.** The script's new home is uncommitted.",
	"",
	"## 5. The toolkit is still installed by onboarding",
	"- **The call.** Onboarding still tells new hires to install the toolkit.",
	"",
	"## 6. After PR 145 merges",
	"- Teammates delete their leftover folder by hand.",
);

const fields = [
	"**The call.** PR 146 names the owners, but nothing enforces a review.",
	"**My pick.** Ask an admin to add the ruleset:",
	"- after PR 146 merges",
	"- before the next release",
	"**What it changes.** A PR to the owned paths waits for an owner.",
	"**Evidence.** `main` has no branch protection and no ruleset.",
	"**Risk.** Your own PRs to those paths wait for the other owner.",
	"**Instead.** Tell me to drop it, and PRs merge as today.",
];

test("a file of numbered headings with bulleted fields fails at every bulleted label and every item missing a label", () => {
	expect(problemLines(bulletFields)).toEqual([3, 4, 5, 9, 10, 12, 13, 16, 17, 18, 20, 21, 22, 25, 26, 28]);
	expect(messageAt(bulletFields, 3)).toEqual(
		Option.some('item "1. Turn on required owner review for `main`" has no line that starts with **Evidence.**'),
	);
	expect(messageAt(bulletFields, 4).pipe(Option.getOrThrow)).toContain("Start the line with **The call.**");
});

test("a file whose items each start a line with every label passes", () => {
	const valid = file(
		"# What this work needs from you",
		"",
		"## Turn on required owner review for main",
		...fields,
		"- **Risk.** quoted in a list, beside the line that carries it",
	);

	expect(actionItemProblems(valid)).toEqual([]);
});

test("a ## or # line inside fenced code neither starts an item nor breaks one", () => {
	const fenced = file(
		"# Needs",
		"",
		"## Rotate the deploy key",
		"```bash",
		"## old key",
		"# revoke it",
		"```",
		"````markdown",
		"```",
		"## shown, not an item",
		"```",
		"````",
		"~~~",
		"## also shown",
		"~~~",
		...fields,
	);

	expect(actionItemProblems(fenced)).toEqual([]);
});

test("a file with only its title and a note has nothing to fix", () => {
	expect(actionItemProblems(file("# What this work needs from you", "", "Nothing waits on you.", ""))).toEqual([]);
	expect(actionItemProblems("")).toEqual([]);
});

test("a label above the first item, a heading inside an item, and a fence left open fail at their lines", () => {
	const broken = file(
		"# Needs",
		"",
		"- **The call.** Before any item.",
		"",
		"## Item",
		...fields,
		"### Details",
		"```",
		"## swallowed",
	);

	expect(problemLines(broken)).toEqual([3, 14, 15]);
});
