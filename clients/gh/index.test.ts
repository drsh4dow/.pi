import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Str from "effect/String";

import { patchIdOf } from "./index.ts";

const diff = (hunk: string, lines: string) =>
	`diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n${hunk}\n${lines}\n`;

const patch = " a\n-b\n+c\n d";

const spaced = Str.replace("+c", "+c ")(patch);

const changedContext = Str.replace(" a", " z")(patch);

const diffs = [
	diff("@@ -1,3 +1,3 @@", patch),
	diff("@@ -10,3 +10,3 @@", patch),
	diff("@@ -1,3 +1,3 @@", spaced),
	diff("@@ -1,3 +1,3 @@", changedContext),
];

const runtime = ManagedRuntime.make(NodeServices.layer);

test("the patch identity holds across moved lines, and changes with whitespace or a changed line of context", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const [base, ...others] = yield* Effect.forEach(diffs, patchIdOf);

			expect(Arr.map(others, (id) => id === base)).toEqual([true, false, false]);
		}),
	));
