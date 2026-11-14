import { expect, test } from "bun:test";

import * as Str from "effect/String";

import { answerOf } from "./answer.ts";

const file = "/s/delegates/child.answer.md";

const whole = [
	{ name: "a 500-character answer", text: Str.repeat(500)("a") },
	{ name: "an answer of exactly 6,000 characters", text: Str.repeat(6000)("a") },
];

for (const { name, text } of whole) {
	test(`${name} reaches the parent whole`, () => {
		expect(answerOf(file)(text)).toEqual({ text, cut: false, file });
	});
}

test("a 20,000-character answer with no paragraph break is cut inside the bound, with the closing line", () => {
	const answer = answerOf(file)(Str.repeat(20_000)("a"));

	expect(answer.cut).toBe(true);
	expect(answer.text.length).toBeLessThanOrEqual(6000);
	expect(answer.text).toStartWith(Str.repeat(5000)("a"));
	expect(answer.text).toEndWith(`of 20,000 characters. Read the whole answer in ${file}]`);
});
