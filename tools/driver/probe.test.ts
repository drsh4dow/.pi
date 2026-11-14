import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { textOf } from "./probe.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const rows = [
	{ name: "a string is its own text", payload: '"hello"', expected: "hello" },
	{
		name: "strings join in traversal order, one per line",
		payload: '{"system":[{"type":"text","text":"rules"}],"messages":[{"role":"user","content":"hi"}]}',
		expected: "text\nrules\nuser\nhi",
	},
	{
		name: "numbers, booleans and null are left out",
		payload: '{"max_tokens":10,"stream":true,"stop":null,"model":"m"}',
		expected: "m",
	},
	{ name: "an empty payload has no text", payload: "{}", expected: "" },
] as const;

for (const { name, payload, expected } of rows) {
	test(`textOf: ${name}`, () =>
		Effect.runPromise(
			Effect.map(decodeJson(payload), (json) => {
				expect(textOf(json)).toBe(expected);
			}),
		));
}
