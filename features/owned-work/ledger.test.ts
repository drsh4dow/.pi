import { afterAll, test } from "bun:test";

import * as Effect from "effect/Effect";

import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { exit, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Spawned, Resync, Answer, End, Group, Stop, TurnEnds, Wakes, Killed, Settles, Timers, Pause } = Act;

const runs = Hook({ event: "run starts" });

const idles = Hook({ event: "goes idle" });

const delegate = Start({ kind: "delegate" });

const rows: ReadonlyArray<Row> = [
	{
		name: "proposed all: one wake with every result, naming the serve the group stopped",
		role: "root",
		acts: [
			runs,
			Start({ kind: "serve" }),
			delegate,
			delegate,
			Group({ mode: "all", refs: ["serve-1", "delegate-2", "delegate-3"], expect: "group-4" }),
			TurnEnds({ expect: "idle: delegate-2, delegate-3, group-4" }),
			idles,
			Answer({ terminal: "t2", text: "a", end: exit(0) }),
			Wakes({ expect: [] }),
			Killed({ expect: [] }),
			Answer({ terminal: "t3", text: "b", end: exit(0) }),
			Killed({ expect: ["t1"] }),
			Wakes({ expect: ["group-4 [delegate-2 done: a, delegate-3 done: b, serve-1 failed: stopped by group-4]"] }),
			Settles({
				expect: [
					"delegate-2 done: a",
					"delegate-3 done: b",
					"serve-1 failed: stopped by group-4",
					"group-4 [delegate-2 done: a, delegate-3 done: b, serve-1 failed: stopped by group-4]",
				],
			}),
			runs,
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "proposed each: one wake per result",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Group({ mode: "each", refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			TurnEnds({ expect: "idle: delegate-1, delegate-2, group-3" }),
			idles,
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Wakes({ expect: ["delegate-1 done: a"] }),
			runs,
			TurnEnds({ expect: "idle: delegate-2, group-3" }),
			idles,
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			Wakes({ expect: ["delegate-2 done: b"] }),
			runs,
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "a watcher keeps a leaf idle and alive until it fires, then the leaf finishes",
		role: "leaf",
		acts: [
			runs,
			Start({ kind: "watch" }),
			TurnEnds({ expect: "idle: watch-1" }),
			idles,
			End({ terminal: "t1", end: exit(3) }),
			Wakes({ expect: ["watch-1 fired 3: tail"] }),
			runs,
			TurnEnds({ expect: "finish: " }),
		],
	},
	{
		name: "a leaf whose only work is a serve finishes at its turn end",
		role: "leaf",
		acts: [runs, Start({ kind: "serve" }), TurnEnds({ expect: "finish: serve-1" })],
	},
	{
		name: "after the parent dies nothing wakes it: no late answer, no deadline",
		role: "owner",
		acts: [
			runs,
			delegate,
			Start({ kind: "watch", deadlineMs: 200 }),
			TurnEnds({ expect: "idle: delegate-1, watch-2" }),
			idles,
			Hook({ event: "parent dies" }),
			Answer({ terminal: "t1", text: "late", end: exit(0) }),
			Pause({ ms: 250 }),
			Wakes({ expect: [] }),
		],
	},
	{
		name: "results wake the agent only at a turn boundary or while idle",
		role: "root",
		acts: [
			runs,
			delegate,
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Wakes({ expect: [] }),
			TurnEnds({ expect: "continue: delegate-1 done: a" }),
			TurnEnds({ expect: "idle: " }),
			idles,
			runs,
			delegate,
			TurnEnds({ expect: "idle: delegate-2" }),
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			Wakes({ expect: [] }),
			idles,
			Wakes({ expect: ["delegate-2 done: b"] }),
		],
	},
	{
		name: "a group adopts a job that settled earlier in the same run",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Group({ mode: "all", refs: ["delegate-1", "delegate-2"], expect: "group-3" }),
			Answer({ terminal: "t2", text: "b", end: exit(0) }),
			TurnEnds({ expect: "continue: group-3 [delegate-1 done: a, delegate-2 done: b]" }),
		],
	},
	{
		name: "a watch past its deadline is killed and fails",
		role: "root",
		acts: [
			runs,
			Start({ kind: "watch", deadlineMs: 30 }),
			TurnEnds({ expect: "idle: watch-1" }),
			idles,
			Pause({ ms: 40 }),
			Killed({ expect: ["t1"] }),
			Wakes({ expect: ["watch-1 failed: deadline"] }),
		],
	},
	{
		name: "careless calls: stop twice, unknown refs, regrouping, the same delegate twice",
		role: "root",
		acts: [
			runs,
			delegate,
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: a" }),
			Stop({ refs: ["delegate-1"], expect: "" }),
			Group({ mode: "all", refs: ["delegate-1"], expect: "delegate-1: its result was already delivered" }),
			Group({ mode: "all", refs: ["nope"], expect: "no work is called nope" }),
			Stop({ refs: ["nope"], expect: "no work is called nope" }),
			Start({ kind: "serve" }),
			Group({
				mode: "all",
				refs: ["serve-2"],
				expect: "a group needs a delegate or a watch, and serve-2 are only serves",
			}),
			delegate,
			Group({ mode: "each", refs: ["delegate-3", "delegate-3"], expect: "group-4" }),
			Group({ mode: "each", refs: ["delegate-3"], expect: "group-4" }),
			Group({ mode: "all", refs: ["delegate-3"], expect: "delegate-3: group-4 holds it" }),
			Stop({ refs: ["group-4"], expect: "delegate-3 failed: stopped by group-4" }),
			Stop({ refs: ["group-4"], expect: "" }),
			Killed({ expect: ["t3"] }),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "a serve stopped before hc confirms its spawn is killed once it spawns",
		role: "root",
		acts: [
			runs,
			Start({ kind: "serve", heldThen: "succeeds" }),
			Stop({ refs: ["serve-1"], expect: "serve-1 failed: stopped by serve-1" }),
			Spawned({ expect: "serve-1" }),
			Killed({ expect: ["t1"] }),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "a serve whose spawn fails stays known: its caller gets the error, and stopping it does nothing",
		role: "root",
		acts: [
			runs,
			Start({ kind: "serve", heldThen: "fails" }),
			Spawned({ expect: "hc terminal.run failed (spawn_failed): no such program" }),
			Stop({ refs: ["serve-1"], expect: "" }),
			Killed({ expect: [] }),
			TurnEnds({ expect: "idle: " }),
		],
	},
	{
		name: "a resync snapshot asked for before a spawn does not mark the new terminal lost",
		role: "root",
		acts: [
			runs,
			delegate,
			Resync({ askedMsAgo: 1000 }),
			TurnEnds({ expect: "idle: delegate-1" }),
			idles,
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Wakes({ expect: ["delegate-1 done: a"] }),
		],
	},
	{
		name: "a serve that exits on its own, or is stopped, records its end once and reaches the agent only beside a stop or a job's result",
		role: "root",
		acts: [
			runs,
			Start({ kind: "serve" }),
			Start({ kind: "serve" }),
			End({ terminal: "t1", end: exit(1) }),
			Stop({ refs: ["serve-2"], expect: "serve-2 failed: stopped by serve-2" }),
			Settles({ expect: ["serve-1 failed: exited", "serve-2 failed: stopped by serve-2"] }),
			TurnEnds({ expect: "idle: " }),
			idles,
			delegate,
			Answer({ terminal: "t3", text: "a", end: exit(0) }),
			Wakes({ expect: ["delegate-3 done: a; serve-1 failed: exited"] }),
		],
	},
	{
		name: "all: a serve that died before the group settled is in the group's result",
		role: "root",
		acts: [
			runs,
			Start({ kind: "serve" }),
			delegate,
			Group({ mode: "all", refs: ["serve-1", "delegate-2"], expect: "group-3" }),
			TurnEnds({ expect: "idle: delegate-2, group-3" }),
			idles,
			End({ terminal: "t1", end: exit(3) }),
			Answer({ terminal: "t2", text: "a", end: exit(0) }),
			Wakes({ expect: ["group-3 [delegate-2 done: a, serve-1 failed: exited]"] }),
		],
	},
	{
		name: "each: its serves' ends never wake the agent, and arrive with its last member's result",
		role: "root",
		acts: [
			runs,
			Start({ kind: "serve" }),
			Start({ kind: "serve" }),
			delegate,
			Group({ mode: "each", refs: ["serve-1", "serve-2", "delegate-3"], expect: "group-4" }),
			TurnEnds({ expect: "idle: delegate-3, group-4" }),
			idles,
			End({ terminal: "t1", end: exit(3) }),
			Wakes({ expect: [] }),
			Answer({ terminal: "t3", text: "a", end: exit(0) }),
			Killed({ expect: ["t2"] }),
			Wakes({ expect: ["delegate-3 done: a; serve-1 failed: exited; serve-2 failed: stopped by group-4"] }),
		],
	},
	{
		name: "a resync snapshot asked for after a spawn settles its missing terminal lost, even if the wall clock stepped back",
		role: "root",
		acts: [
			runs,
			delegate,
			Act.WallClockSteps({ backMs: 3_600_000 }),
			Resync({ askedMsAgo: 0 }),
			TurnEnds({ expect: "continue: delegate-1 failed: lost" }),
		],
	},
	{
		name: "a deadline's timer ends as soon as its job settles",
		role: "root",
		acts: [
			runs,
			Start({ kind: "watch", deadlineMs: 600_000 }),
			Timers({ expect: 1 }),
			End({ terminal: "t1", end: exit(0) }),
			Timers({ expect: 0 }),
			TurnEnds({ expect: "continue: watch-1 fired 0: tail" }),
		],
	},
];

for (const row of rows) {
	test(row.name, () => Effect.runPromise(runRow(row)));
}

const cleanup = Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet());

afterAll(() => Effect.runPromise(cleanup));
