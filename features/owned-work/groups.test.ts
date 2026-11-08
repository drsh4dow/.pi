import { afterAll, test } from "bun:test";

import * as Effect from "effect/Effect";

import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { exit, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Answer, Group, Stop, TurnEnds } = Act;

const runs = Hook({ event: "run starts" });

const delegate = Start({ kind: "delegate" });

const rows: ReadonlyArray<Row> = [
	{
		name: "grouping an each group that already settled says so, and its member's result still arrives",
		role: "root",
		acts: [
			runs,
			delegate,
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Group({ mode: "each", refs: ["delegate-1"], expect: "group-2" }),
			Group({
				mode: "all",
				refs: ["group-2"],
				expect:
					"group-2: it is an each group that already settled: its members' results reach you one by one, and it has none of its own",
			}),
			TurnEnds({ expect: "continue: delegate-1 done: a" }),
		],
	},
	{
		name: "stopping an all group hands over the answers its members already gave",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ mode: "all", refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Stop({ refs: ["group-3"], expect: "group-3 [delegate-1 done: a, delegate-2 failed: stopped by group-3]" }),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "stopping a nested all group hands each member's result over once, inside its groups",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ mode: "all", refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			delegate,
			Group({ mode: "all", refs: ["group-3", "delegate-4"], expect: "group-5" }),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Stop({
				refs: ["group-5"],
				expect:
					"group-5 [group-3 [delegate-1 done: a, delegate-2 failed: stopped by group-5], delegate-4 failed: stopped by group-5]",
			}),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "stopping a member together with its all group still hands over the group's result",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ mode: "all", refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			Stop({
				refs: ["delegate-1", "group-3"],
				expect: "group-3 [delegate-1 failed: stopped by delegate-1, delegate-2 done: b]",
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
