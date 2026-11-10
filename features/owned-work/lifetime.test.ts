import { afterAll, test } from "bun:test";

import * as Effect from "effect/Effect";

import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { exit, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Answer, Group, Stop, Running, TurnEnds } = Act;

const runs = Hook({ event: "run starts" });

const delegate = Start({ kind: "delegate" });

const rows: ReadonlyArray<Row> = [
	{
		name: "what a session switch would stop is the live work the agent holds, a group standing for its members",
		role: "root",
		acts: [
			runs,
			Start({ kind: "serve" }),
			delegate,
			Start({ kind: "watch" }),
			delegate,
			Group({ mode: "all", refs: ["delegate-2", "watch-3"], expect: "group-5" }),
			Answer({ terminal: "t4", text: "a", end: exit(0) }),
			Running({ expect: ["serve-1", "group-5"] }),
			TurnEnds({ expect: "continue: delegate-4 done: a" }),
			Stop({
				refs: ["serve-1", "group-5"],
				expect:
					"group-5 [delegate-2 failed: stopped by group-5, watch-3 failed: stopped by group-5]; serve-1 failed: stopped by serve-1",
			}),
			Running({ expect: [] }),
		],
	},
];

for (const row of rows) {
	test(row.name, () => Effect.runPromise(runRow(row)));
}

const cleanup = Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet());

afterAll(() => Effect.runPromise(cleanup));
