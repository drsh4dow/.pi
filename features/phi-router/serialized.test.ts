import { expect, test } from "bun:test";

import type { Message } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";

import { asked, branchOf, done, personal, run, syntheticChart, system, worldOf } from "./router.fixture.ts";

const tool = { name: "lookup", description: "Looks a row up.", parameters: { type: "object", properties: {} } };

const carriers: ReadonlyArray<{ readonly field: string; readonly message: Message }> = [
	{
		field: "a tool's description",
		message: { role: "system", content: "", toolsAdded: [{ ...tool, description: syntheticChart }], timestamp: 0 },
	},
	{
		field: "a tool's parameter schema",
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

for (const [index, { field, message }] of carriers.entries()) {
	test(`PHI in ${field}, which Anthropic receives, sends the request to ent`, () =>
		run(
			Effect.gen(function* () {
				const branch = yield* branchOf({ world: yield* worldOf({ name: `serialized-${String(index)}` }) });
				const conversation = [system, asked("Hi."), done("ultra-a"), message, asked("Go on.")];
				const routed = yield* branch.send("user", conversation);

				expect(routed).toBe("ent");
			}),
		));
}
