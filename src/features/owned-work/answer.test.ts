import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Str from "effect/String";

import { answerOf } from "./answer.ts";

const file = "/s/delegates/child.answer.md";

const whole = [
	{ name: "a 500-character answer", text: Str.repeat(500)("a") },
	{ name: "an answer of exactly 6,000 characters", text: Str.repeat(6000)("a") },
];

test.each(whole)("$name reaches the parent whole", ({ text }) => {
	expect(answerOf(file)(text)).toEqual({ text, cut: false, file });
});

test("a 20,000-character answer with no paragraph break is cut inside the bound, with the closing line", () => {
	const answer = answerOf(file)(Str.repeat(20_000)("a"));

	expect(answer.cut).toBe(true);
	expect(answer.text.length).toBeLessThanOrEqual(6000);
	expect(answer.text).toStartWith(Str.repeat(5000)("a"));
	expect(answer.text).toEndWith(`of 20,000 characters. Read the whole answer in ${file}]`);
});

const paragraphList = Arr.makeBy(20, (index) => `${String(index)}${Str.repeat(999)("a")}`);

const paragraphs = (blank: string) => Arr.join(paragraphList, blank);

test.each([
	["CRLF", "\r\n\r\n"],
	["a blank line holding spaces", "\n  \n"],
] as const)("an answer whose paragraphs part with %s is cut at a paragraph", (_name, blank) => {
	const { text } = answerOf(file)(paragraphs(blank));

	expect(text).toStartWith(`${Arr.join(Arr.take(paragraphList, 5), blank)}\n\n[The answer is cut at`);
});

test("a cut never splits a character outside the basic plane", () => {
	const { text } = answerOf(file)(Str.repeat(4000)("😀"));

	expect(text.isWellFormed()).toBe(true);
});

test("a paragraph that ends exactly where the room ends is kept", () => {
	const room = 6000 - 2 - `[The answer is cut at 6,000 of 20,000 characters. Read the whole answer in ${file}]`.length;
	const kept = `a\n\n${Str.repeat(room - 3)("b")}`;
	const { text } = answerOf(file)(`${kept}\n\n${Str.repeat(20_000 - room - 2)("c")}`);

	expect(text).toBe(
		`${kept}\n\n[The answer is cut at ${room.toLocaleString("en-US")} of 20,000 characters. Read the whole answer in ${file}]`,
	);
});
