import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Str from "effect/String";

import { checks } from "./checks.ts";

const home = `${Bun.env["TMPDIR"] ?? "/tmp"}/state-checks-test-${String(process.pid)}`;
const folder = `${home}/.local/state/pi-agent/pi/work`;

const runTest = <Value, Failure>(effect: Effect.Effect<Value, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

await runTest(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		yield* fs.makeDirectory(folder, { recursive: true });
	}),
);

/** The problems a state file's check finds in this text: their lines, and their messages as one text. */
const problemsOf = Effect.fn("problemsOf")(function* (name: string, text: string) {
	const check = yield* Effect.fromNullishOr(checks.get(name));
	const problems = yield* check.problems(text);

	return {
		lines: Arr.map(problems, ({ line }) => line),
		messages: Arr.join(
			Arr.map(problems, ({ message }) => message),
			"\n",
		),
	};
});

const sixteenKib = Arr.join(Arr.replicate(Str.repeat(1023)("x"), 16), "\n");

test.each([
	["a dated level-2 heading", "# State\n\n## 2026-11-13 session\nDid things.\n", [3]],
	["a dated level-3 heading", "# State\n\n## Status\n### Done 2026-11-13\n", [4]],
	["headings without a date", "# State\n\n## Destination\nShip it.\n## Next step\nTest.\n", []],
	["a dated heading inside a code fence", "# State\n\n```\n## 2026-11-13\n```\n", []],
	["exactly 16,384 bytes", `${sixteenKib}\n`, []],
	["16,385 bytes, crossing on line 17", `${sixteenKib}\nx`, [17]],
])("STATE.md with %s", (_case, text, lines) =>
	runTest(
		Effect.gen(function* () {
			const found = yield* problemsOf("STATE.md", text);

			expect(found.lines).toEqual(lines);
		}),
	),
);

test("STATE.md over the cap names its size and the cap", () =>
	runTest(
		Effect.gen(function* () {
			const { messages } = yield* problemsOf("STATE.md", `${sixteenKib}\nx`);

			expect(messages).toContain("16,385 bytes");
			expect(messages).toContain("16,384 bytes");
		}),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${home}`.quiet())));
