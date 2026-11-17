import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { VerdictResult } from "#src/features/pr/index.ts";
import { callerOf, delegate, pinned, runtime, started } from "./brief.fixture.ts";
import { lastLineVerdict } from "./review.ts";

const lines: ReadonlyArray<readonly [string, string, Option.Option<VerdictResult>]> = [
	["a pass", "Checked.\n\nVERDICT: PASS", Option.some("pass")],
	["a pass with notes", "VERDICT: PASS+NOTES", Option.some("pass+notes")],
	["a fail followed by blank lines", "VERDICT: FAIL\n\n  \n", Option.some("fail")],
	["an incomplete review", "VERDICT: INCOMPLETE", Option.some("incomplete")],
	["a bold line in lower case", "**VERDICT: pass**", Option.some("pass")],
	["a later verdict line over an earlier one", "VERDICT: FAIL\nVERDICT: PASS", Option.some("pass")],
	["a verdict line with text after it", "VERDICT: PASS\n\nThen the build broke.", Option.none()],
	["a verdict in prose", "The verdict is pass.", Option.none()],
	["a word outside the four", "VERDICT: MAYBE", Option.none()],
	["an empty answer", "", Option.none()],
];

for (const [name, text, expected] of lines) {
	test(`the verdict line of ${name}`, () => {
		expect(lastLineVerdict(text)).toEqual(expected);
	});
}

const call = { name: "verify", message: "Review it.", goal: "Cap the retries.", model: "quick", reviews: "7" };

const execute = (roleOf: { readonly role: "owner"; readonly design: string } | { readonly role: "leaf" }) =>
	Effect.gen(function* () {
		const { isError, details } = yield* Effect.promise(() =>
			delegate.execute("call", { ...call, ...roleOf }, undefined, undefined, callerOf()),
		);

		return { isError, details, reviews: Arr.map(started.splice(0), ({ brief }) => brief.review) };
	});

test("an owner call with reviews fails before anything spawns", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const got = yield* execute({ role: "owner", design: "yours" });

			expect(got).toEqual({
				isError: true,
				details: {
					error: "BadDelegate",
					message: "`reviews` starts a verifier, which is a leaf: name role `leaf`",
				},
				reviews: [],
			});
		}),
	));

test("a leaf call with reviews pins the pull request's repository, number, head and patch-id in the brief", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const got = yield* execute({ role: "leaf" });

			expect(got).toMatchObject({ isError: false, reviews: [pinned] });
		}),
	));
