import { test } from "bun:test";

import * as Effect from "effect/Effect";

import { Act, type Row, runRow } from "./ledger.fixture.ts";

const spawnFails: Row = {
	name: "a watch whose command never started wakes the agent with no log",
	role: "root",
	acts: [
		Act.Hook({ event: "run starts" }),
		Act.Start({ kind: "watch", heldThen: "fails" }),
		Act.Spawned({ expect: "watch-1" }),
		Act.TurnEnds({ expect: "continue: watch-1 failed: spawn failed" }),
	],
};

test(spawnFails.name, () => Effect.runPromise(runRow(spawnFails)));
