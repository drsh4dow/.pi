import { expect, test } from "bun:test";

import type { Message } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";

import { asked, branchOf, done, personal, run, syntheticChart, system, worldOf } from "./router.fixture.ts";

const tool = { name: "lookup", description: "Looks a row up.", parameters: { type: "object", properties: {} } };

const carriers: ReadonlyArray<{ readonly field: string; readonly world: string; readonly message: Message }> = [
	{
		field: "a tool's description",
		world: "serialized-0",
		message: { role: "system", content: "", toolsAdded: [{ ...tool, description: syntheticChart }], timestamp: 0 },
	},
	{
		field: "a tool's parameter schema",
		world: "serialized-1",
		message: {
			role: "system",
			content: "",
			toolsAdded: [
				{ ...tool, parameters: { type: "object", properties: { patient: { description: syntheticChart } } } },
			],
			timestamp: 0,
		},
	},
	{
		field: "a removed tool's name",
		world: "serialized-2",
		message: { role: "system", content: "", toolsRemoved: [{ name: syntheticChart }], timestamp: 0 },
	},
];

test("a clean conversation with a tool on its system turn goes personal", () =>
	run(
		Effect.gen(function* () {
			const branch = yield* branchOf({ world: yield* worldOf({ name: "serialized-clean" }) });
			const toolTurn: Message = { role: "system", content: "", toolsAdded: [tool], timestamp: 0 };

			const routed = yield* branch.send("user", [system, toolTurn, asked("Hi.")]);

			expect(personal).toContain(routed);
		}),
	));

test.each(carriers)("PHI in $field, which Anthropic receives, sends the request to ent", ({ world, message }) =>
	run(
		Effect.gen(function* () {
			const branch = yield* branchOf({ world: yield* worldOf({ name: world }) });
			const conversation = [system, asked("Hi."), done("ultra-a"), message, asked("Go on.")];
			const routed = yield* branch.send("user", conversation);

			expect(routed).toBe("ent");
		}),
	),
);
