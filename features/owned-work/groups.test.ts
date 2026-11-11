import { afterAll, test } from "bun:test";

import * as Effect from "effect/Effect";

import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { exit, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Spawned, Answer, Group, Cancel, TurnEnds, Shown } = Act;

const runs = Hook({ event: "run starts" });

const delegate = Start({ kind: "delegate" });

const rows: ReadonlyArray<Row> = [
	{
		name: "each terminal is named for the list of running agents and labeled with its kind",
		role: "root",
		acts: [
			runs,
			delegate,
			Start({ kind: "watch" }),
			Start({ kind: "serve" }),
			Shown({ expect: ["review-it (ow.kind=delegate)", "watch (ow.kind=watch)", "serve (ow.kind=serve)"] }),
			Cancel({
				refs: ["delegate-1", "watch-2", "serve-3"],
				expect:
					"delegate-1 failed: cancelled by your cancel call; watch-2 failed: cancelled by your cancel call; serve-3 failed: cancelled by your cancel call",
			}),
		],
	},
	{
		name: "a group shows its live members under its name, and a member still starting once it starts",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Start({ kind: "delegate", heldThen: "succeeds" }),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Shown({ expect: ["review-it (ow.kind=delegate)", "review-it (ow.kind=delegate)"] }),
			Group({ refs: ["delegate-1", "delegate-2", "delegate-3"], expect: "group-4" }),
			Shown({ expect: ["t2 (ow.group=group-4, ow.group.name=principles eval)"] }),
			Spawned({ expect: "delegate-3" }),
			Shown({ expect: ["review-it (ow.kind=delegate)", "t3 (ow.group=group-4, ow.group.name=principles eval)"] }),
			Cancel({
				refs: ["group-4"],
				expect:
					"group-4 [delegate-1 done: a, delegate-2 failed: cancelled by your cancel call, delegate-3 failed: cancelled by your cancel call]",
			}),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "cancelling a group hands over the answers its members already gave",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Cancel({
				refs: ["group-3"],
				expect: "group-3 [delegate-1 done: a, delegate-2 failed: cancelled by your cancel call]",
			}),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "cancelling a nested group hands each member's result over once, inside its groups",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			delegate,
			Group({ refs: ["group-3", "delegate-4"], expect: "group-5" }),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Cancel({
				refs: ["group-5"],
				expect:
					"group-5 [group-3 [delegate-1 done: a, delegate-2 failed: cancelled by your cancel call], delegate-4 failed: cancelled by your cancel call]",
			}),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "cancelling a member together with its group still hands over the group's result",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			Cancel({
				refs: ["delegate-1", "group-3"],
				expect: "group-3 [delegate-1 failed: cancelled by your cancel call, delegate-2 done: b]",
			}),
			TurnEnds({ expect: "idle: " }),
		],
	},
];

for (const row of rows) {
	test(row.name, () => Effect.runPromise(runRow(row)));
}

const cleanup = Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet());

afterAll(() => Effect.runPromise(cleanup));
