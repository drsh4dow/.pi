import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { Payload, render } from "./render.ts";

const reportOf = (payload: Payload) => ({
	piVersion: "1.0.0",
	project: "/p",
	captures: [{ title: "Root agent", about: "The pi you start.", payload }],
});

const fenced = "````text\nYou are pi.\n\nFollow the rules.\n````";

const payloadRows = [
	{
		name: "an Anthropic request shows its system blocks",
		payload: {
			model: "claude-opus-5-5",
			system: [
				{ type: "text", text: "You are pi." },
				{ type: "text", text: "Follow the rules." },
			],
			messages: [{ role: "user", content: "ok" }],
		},
	},
	{
		name: "an OpenAI Responses request shows its developer and system messages, and not its tool list",
		payload: {
			model: "gpt-6.1-sol",
			input: [
				{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "read" }] },
				{ role: "developer", content: "You are pi." },
				{ role: "system", content: "Follow the rules." },
				{ role: "user", content: [{ type: "input_text", text: "ok" }] },
				{ type: "configuration_update", reasoning: { effort: "high" } },
			],
		},
	},
];

for (const row of payloadRows) {
	test(row.name, () =>
		Effect.runPromise(
			Effect.map(Schema.decodeEffect(Payload)(row.payload), (payload) => {
				expect(render(reportOf(payload))).toContain(`## Root agent\n\nThe pi you start.\n\n${fenced}`);
			}),
		),
	);
}
