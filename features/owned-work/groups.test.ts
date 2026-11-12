import { afterAll, test } from "bun:test";

import * as Effect from "effect/Effect";

import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { exit, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Spawned, Answer, Group, Cancel, TurnEnds, Wakes, Shown } = Act;

const runs = Hook({ event: "run starts" });

const idles = Hook({ event: "goes idle" });

const delegate = Start({ kind: "delegate" });

const reviewing = (ref: string, terminal: string, group: string) =>
	Start({
		kind: "delegate",
		group: "review",
		handle: { ref, kind: "delegate", terminal, group, next: `end your turn; ${group} wakes you` },
	});

const rows: ReadonlyArray<Row> = [
	{
		name: "delegates started with one group name share one group, which wakes once with all their answers",
		role: "root",
		acts: [
			runs,
			reviewing("delegate-1", "t1", "group-2"),
			reviewing("delegate-3", "t2", "group-2"),
			reviewing("delegate-4", "t3", "group-2"),
			Shown({
				expect: [
					"review-it (ow.kind=delegate)",
					"t1 (ow.group=group-2, ow.group.name=review)",
					"review-it (ow.kind=delegate)",
					"t2 (ow.group=group-2, ow.group.name=review)",
					"review-it (ow.kind=delegate)",
					"t3 (ow.group=group-2, ow.group.name=review)",
				],
			}),
			TurnEnds({ expect: "idle: delegate-1, group-2, delegate-3, delegate-4" }),
			idles,
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			Wakes({ expect: [] }),
			Answer({ terminal: "t3", text: "c", end: exit(0) }),
			Wakes({ expect: ["group-2 [delegate-1 done: a, delegate-3 done: b, delegate-4 done: c]"] }),
		],
	},
	{
		name: "a delegate started with the name of a group that already settled starts a new group",
		role: "root",
		acts: [
			runs,
			reviewing("delegate-1", "t1", "group-2"),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			reviewing("delegate-3", "t2", "group-4"),
			TurnEnds({ expect: "continue: group-2 [delegate-1 done: a]" }),
			TurnEnds({ expect: "idle: delegate-3, group-4" }),
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			TurnEnds({ expect: "continue: group-4 [delegate-3 done: b]" }),
		],
	},
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
					"delegate-1 failed: cancelled by your cancel call; watch-2 failed: cancelled by your cancel call (log watch.log); serve-3 failed: cancelled by your cancel call",
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
	{
		name: "cancelling a group's last running member hands over the group's result",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			Cancel({
				refs: ["delegate-1"],
				expect: "group-3 [delegate-1 failed: cancelled by your cancel call, delegate-2 done: b]",
			}),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "cancelling the last running member of a nested group hands over the outermost group's result",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			delegate,
			Group({ refs: ["group-3", "delegate-4"], expect: "group-5" }),
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			Answer({ terminal: "t3", text: "c", end: exit(0) }),
			Cancel({
				refs: ["delegate-1"],
				expect:
					"group-5 [group-3 [delegate-1 failed: cancelled by your cancel call, delegate-2 done: b], delegate-4 done: c]",
			}),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "cancelling a member while another still runs hands over nothing, and the group still wakes with both",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			Cancel({ refs: ["delegate-1"], expect: "" }),
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			TurnEnds({
				expect: "continue: group-3 [delegate-1 failed: cancelled by your cancel call, delegate-2 done: b]",
			}),
		],
	},
];

for (const row of rows) {
	test(row.name, () => Effect.runPromise(runRow(row)));
}

const cleanup = Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet());

afterAll(() => Effect.runPromise(cleanup));
