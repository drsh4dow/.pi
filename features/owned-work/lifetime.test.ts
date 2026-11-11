import { afterAll, test } from "bun:test";

import * as Effect from "effect/Effect";

import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { exit, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Answer, End, Group, Cancel, Running, Waking, TurnEnds, Wakes, Killed, Leftovers, Pause } = Act;

const runs = Hook({ event: "run starts" });

const idles = Hook({ event: "goes idle" });

const reloads = Hook({ event: "pi reloads" });

const watch = Start({ kind: "watch" });

const delegate = Start({ kind: "delegate" });

const rows: ReadonlyArray<Row> = [
	{
		name: "what a session switch would stop is the live work the agent holds, a group standing for its members, and all but its serves will wake it",
		role: "root",
		acts: [
			runs,
			Start({ kind: "serve" }),
			delegate,
			Start({ kind: "watch" }),
			delegate,
			Group({ refs: ["delegate-2", "watch-3"], expect: "group-5" }),
			Answer({ terminal: "t4", text: "a", end: exit(0) }),
			Running({ expect: ["serve-1", "group-5"] }),
			Waking({ expect: ["group-5"] }),
			TurnEnds({ expect: "continue: delegate-4 done: a" }),
			Cancel({
				refs: ["serve-1", "group-5"],
				expect:
					"group-5 [delegate-2 failed: cancelled by your cancel call, watch-3 failed: cancelled by your cancel call (log watch.log)]; serve-1 failed: cancelled by your cancel call",
			}),
			Running({ expect: [] }),
		],
	},
	{
		name: "a reload keeps the work running: a watch that ends after it wakes the agent once, and refs carry on",
		role: "root",
		acts: [
			runs,
			watch,
			idles,
			reloads,
			runs,
			watch,
			Running({ expect: ["watch-1", "watch-2"] }),
			idles,
			End({ terminal: "t1", end: exit(0) }),
			Wakes({ expect: ["watch-1 fired 0 (log watch.log): tail"] }),
			idles,
			End({ terminal: "t2", end: exit(0) }),
			Wakes({ expect: ["watch-2 fired 0 (log watch.log): tail"] }),
			Killed({ expect: [] }),
		],
	},
	{
		name: "after a reload a watch's deadline counts from when the watch started",
		role: "root",
		acts: [
			runs,
			Start({ kind: "watch", deadlineMs: 300 }),
			idles,
			Pause({ ms: 200 }),
			reloads,
			Pause({ ms: 150 }),
			Wakes({ expect: ["watch-1 failed: deadline (log watch.log)"] }),
			Killed({ expect: ["t1"] }),
		],
	},
	{
		name: "a result a group holds survives a reload and reaches the agent with the group",
		role: "root",
		acts: [
			runs,
			delegate,
			watch,
			Group({ refs: ["delegate-1", "watch-2"], expect: "group-3" }),
			End({ terminal: "t2", end: exit(0) }),
			idles,
			reloads,
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Wakes({ expect: ["group-3 [delegate-1 done: a, watch-2 fired 0 (log watch.log): tail]"] }),
		],
	},
	{
		name: "a running delegate keeps its staged files across a reload, until it settles",
		role: "root",
		acts: [
			runs,
			delegate,
			idles,
			reloads,
			Leftovers({ expect: ["t1.instructions", "t1.message"] }),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Leftovers({ expect: [] }),
		],
	},
	{
		name: "a root that quits after a reload still leaves no staged files",
		role: "root",
		acts: [runs, delegate, idles, reloads, Hook({ event: "parent dies" }), Leftovers({ expect: [] })],
	},
];

for (const row of rows) {
	test(row.name, () => Effect.runPromise(runRow(row)));
}

const cleanup = Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet());

afterAll(() => Effect.runPromise(cleanup));
