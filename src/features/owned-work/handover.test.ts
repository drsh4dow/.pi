import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { Inheritance, inheritanceOf, rootSliceOf } from "./handover.ts";
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

const manager = "0::/user.slice/user-1000.slice/user@1000.service";

const slices = [
	{
		name: "a root started outside owned work gets a slice of its own",
		cgroup: `${manager}/app.slice/app-herdr-core.scope\n`,
		expected: "pi-ow-k1",
	},
	{
		name: "a root a watch started nests its slice in the watch's, so stopping the watch stops the root's delegates",
		cgroup: `${manager}/pi.slice/pi-ow.slice/pi-ow-ab.slice/pi-ow-ab-watch3.slice/pi-ow-ab-watch3.scope\n`,
		expected: "pi-ow-ab-watch3-k1",
	},
	{
		name: "a root with no cgroup to read gets a slice of its own",
		cgroup: "",
		expected: "pi-ow-k1",
	},
];

for (const { name, cgroup, expected } of slices) {
	test(name, () => {
		expect(rootSliceOf(cgroup)("k1")).toBe(expected);
	});
}
