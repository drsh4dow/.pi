import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { Inheritance, inheritanceOf } from "./handover.ts";
import { Transitions } from "./transitions.ts";
import { MonotonicNanos } from "./work.ts";

const state = Transitions.initial("root", 4, MonotonicNanos(0n));

const handover = Option.some({ agentKey: "old", stamp: 7, state });

const thisLoad = inheritanceOf({ agentKey: "new", stamp: 7 });

const rows = [
	{
		name: "a reload by the same ledger code takes the work over, under the old key",
		got: thisLoad("reload", handover),
		expected: Inheritance.Carried({ agentKey: "old", state }),
	},
	{
		name: "a reload that changed the ledger code stops the old work and starts under a new key",
		got: inheritanceOf({ agentKey: "new", stamp: 8 })("reload", handover),
		expected: Inheritance.Stale({ agentKey: "new", stale: "old" }),
	},
	{
		name: "a reload with nothing handed over starts fresh",
		got: thisLoad("reload", Option.none()),
		expected: Inheritance.Fresh({ agentKey: "new" }),
	},
	...Arr.map(["startup", "new", "resume", "fork"] as const, (reason) => ({
		name: `a ${reason} start ignores a handover and starts fresh`,
		got: thisLoad(reason, handover),
		expected: Inheritance.Fresh({ agentKey: "new" }),
	})),
];

for (const { name, got, expected } of rows) {
	test(name, () => {
		expect(got).toEqual(expected);
	});
}
