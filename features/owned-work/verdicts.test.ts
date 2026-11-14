import { afterAll, test } from "bun:test";

import * as Effect from "effect/Effect";

import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { exit, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Answer, TurnEnds, Delivered, VerdictRecords } = Act;

const runs = Hook({ event: "run starts" });

const answerFile = (session: string) => `${sessionRoot}/delegates/${session}.answer.md`;

const interrogate = (head: string) =>
	`This is the second failed review of o/r#4. Run interrogate on head ${head} before a third serial review.`;

const stop =
	"This is failed review 3 of o/r#4. Stop patching: redesign the part that keeps failing, or report the work as blocked with what remains.";

interface Woken {
	readonly ref: string;
	readonly name: string;
	readonly session: string;
	readonly text: string;
	readonly verdict: object;
}

const wake = ({ ref, name, session, text, verdict }: Woken) => ({
	ref,
	kind: "delegate",
	name,
	session,
	outcome: { status: "done", text, cut: false, answer: answerFile(session), verdict },
});

const recordOf = (pr: number, head: string, result: string, name: string, session: string) => ({
	repo: "o/r",
	number: pr,
	head,
	patchId: "p",
	result,
	verifier: { name, session, model: "a/b" },
	answer: answerFile(session),
});

const rows: ReadonlyArray<Row> = [
	{
		name: "an author's verifier leaves a record with its pinned pull request and its identity, and the wake carries the verdict",
		role: "owner",
		acts: [
			runs,
			Start({ kind: "delegate", name: "verifier", reviews: { number: 1, head: "h1" } }),
			Answer({ terminal: "t1", text: "VERDICT: FAIL\n\nFixed on a second look.\n\nVERDICT: PASS", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: VERDICT: FAIL\n\nFixed on a second look.\n\nVERDICT: PASS" }),
			Delivered({
				expect: (sessionOf) => [
					wake({
						ref: "delegate-1",
						name: "verifier",
						session: sessionOf("t1"),
						text: "VERDICT: FAIL\n\nFixed on a second look.\n\nVERDICT: PASS",
						verdict: { pr: "o/r#1", head: "h1", result: "pass" },
					}),
				],
			}),
			VerdictRecords({ pr: 1, expect: (sessionOf) => [recordOf(1, "h1", "pass", "verifier", sessionOf("t1"))] }),
		],
	},
	{
		name: "a verifier's answer with no verdict line records incomplete",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate", name: "verifier", reviews: { number: 2, head: "h2" } }),
			Answer({ terminal: "t1", text: "The tests pass.", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: The tests pass." }),
			VerdictRecords({
				pr: 2,
				expect: (sessionOf) => [recordOf(2, "h2", "incomplete", "verifier", sessionOf("t1"))],
			}),
		],
	},
	{
		name: "two verifiers on one head leave two records",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate", name: "verifier a", reviews: { number: 3, head: "h3" } }),
			Start({ kind: "delegate", name: "verifier b", reviews: { number: 3, head: "h3" } }),
			Answer({ terminal: "t1", text: "VERDICT: PASS", end: exit(0) }),
			Answer({ terminal: "t2", text: "VERDICT: PASS+NOTES", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: VERDICT: PASS; delegate-2 done: VERDICT: PASS+NOTES" }),
			VerdictRecords({
				pr: 3,
				expect: (sessionOf) => [
					recordOf(3, "h3", "pass", "verifier a", sessionOf("t1")),
					recordOf(3, "h3", "pass+notes", "verifier b", sessionOf("t2")),
				],
			}),
		],
	},
	{
		name: "the second failed review of one pull request adds the interrogate line, and the third says to stop patching",
		role: "owner",
		acts: [
			runs,
			Start({ kind: "delegate", name: "verifier 1", reviews: { number: 4, head: "h4a" } }),
			Answer({ terminal: "t1", text: "VERDICT: FAIL", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: VERDICT: FAIL" }),
			Start({ kind: "delegate", name: "verifier 2", reviews: { number: 4, head: "h4b" } }),
			Answer({ terminal: "t2", text: "VERDICT: FAIL", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-2 done: VERDICT: FAIL" }),
			Start({ kind: "delegate", name: "verifier 3", reviews: { number: 4, head: "h4c" } }),
			Answer({ terminal: "t3", text: "VERDICT: FAIL", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-3 done: VERDICT: FAIL" }),
			Delivered({
				expect: (sessionOf) => [
					wake({
						ref: "delegate-1",
						name: "verifier 1",
						session: sessionOf("t1"),
						text: "VERDICT: FAIL",
						verdict: { pr: "o/r#4", head: "h4a", result: "fail" },
					}),
					wake({
						ref: "delegate-2",
						name: "verifier 2",
						session: sessionOf("t2"),
						text: "VERDICT: FAIL",
						verdict: { pr: "o/r#4", head: "h4b", result: "fail", next: interrogate("h4b") },
					}),
					wake({
						ref: "delegate-3",
						name: "verifier 3",
						session: sessionOf("t3"),
						text: "VERDICT: FAIL",
						verdict: { pr: "o/r#4", head: "h4c", result: "fail", next: stop },
					}),
				],
			}),
		],
	},
];

for (const row of rows) {
	test(row.name, () => Effect.runPromise(runRow(row)));
}

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet())));
