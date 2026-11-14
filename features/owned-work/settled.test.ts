import { afterAll, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";

import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { exit, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Answer, End, Running, Shown, TurnEnds, Delivered, AnswerFiles, Leftovers } = Act;

const runs = Hook({ event: "run starts" });

const idles = Hook({ event: "goes idle" });

const answerFile = (session: string) => `${sessionRoot}/delegates/${session}.answer.md`;

const paragraph = (number: number) => Str.padEnd(998, "x")(`Paragraph ${String(number)}: `);

const longAnswer = Arr.join(
	Arr.map(Arr.range(1, 20), (number) => `${paragraph(number)}\n\n`),
	"",
);

const firstFive = Arr.join(Arr.map(Arr.range(1, 5), paragraph), "\n\n");

const rows: ReadonlyArray<Row> = [
	{
		name: "a wake names each delegate and its child session, a group member too, and a watch its command",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate", name: "slice owner" }),
			Start({ kind: "delegate", name: "reviewer", group: "review" }),
			Start({ kind: "watch" }),
			Answer({ terminal: "t1", text: "built", end: exit(0) }),
			Answer({ terminal: "t2", text: "VERDICT: pass", end: exit(0) }),
			End({ terminal: "t3", end: exit(0) }),
			TurnEnds({
				expect:
					"continue: delegate-1 done: built; group-3 [delegate-2 done: VERDICT: pass]; watch-4 fired 0 (log watch.log): tail",
			}),
			Delivered({
				expect: (sessionIdOf) => [
					{
						ref: "delegate-1",
						kind: "delegate",
						name: "slice owner",
						session: sessionIdOf("t1"),
						outcome: { status: "done", text: "built", cut: false, answer: answerFile(sessionIdOf("t1")) },
					},
					{
						ref: "group-3",
						kind: "group",
						name: "review",
						outcome: {
							status: "settled",
							members: [
								{
									ref: "delegate-2",
									kind: "delegate",
									name: "reviewer",
									session: sessionIdOf("t2"),
									outcome: {
										status: "done",
										text: "VERDICT: pass",
										cut: false,
										answer: answerFile(sessionIdOf("t2")),
									},
								},
							],
						},
					},
					{
						ref: "watch-4",
						kind: "watch",
						command: "watch",
						outcome: { status: "fired", exit_code: 0, log: "watch.log", tail: "tail" },
					},
				],
			}),
		],
	},
	{
		name: "a second delegate under a name a live one holds is refused before it spawns, and the name is free once the first settles",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate", name: "slice owner" }),
			Start({
				kind: "delegate",
				name: "slice owner",
				refused:
					'delegate-1 runs under the name "slice owner"; pick another name, or wait for delegate-1 to settle',
			}),
			Running({ expect: ["delegate-1"] }),
			Shown({ expect: ["slice-owner (ow.kind=delegate)"] }),
			Answer({ terminal: "t1", text: "built", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: built" }),
			Start({ kind: "delegate", name: "slice owner" }),
			Running({ expect: ["delegate-2"] }),
			Shown({ expect: ["slice-owner (ow.kind=delegate)"] }),
			Answer({ terminal: "t2", text: "built again", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-2 done: built again" }),
		],
	},
	{
		name: "a 20,000-character answer wakes cut at a paragraph inside 6,000 characters, and its file holds it whole",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate" }),
			TurnEnds({ expect: "idle: delegate-1" }),
			idles,
			Answer({ terminal: "t1", text: longAnswer, end: exit(0) }),
			Delivered({
				expect: (sessionIdOf) => [
					{
						ref: "delegate-1",
						kind: "delegate",
						name: "Review 1",
						session: sessionIdOf("t1"),
						outcome: {
							status: "done",
							text: `${firstFive}\n\n[The answer is cut at 4,998 of 20,000 characters. Read the whole answer in ${answerFile(sessionIdOf("t1"))}]`,
							cut: true,
							answer: answerFile(sessionIdOf("t1")),
						},
					},
				],
			}),
			AnswerFiles({ expect: [longAnswer] }),
			Leftovers({ expect: ["t1.answer.md"] }),
		],
	},
];

for (const row of rows) {
	test(row.name, () => Effect.runPromise(runRow(row)));
}

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet())));
