import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { lfLines, type Root, startRoot } from "./root.ts";
import { layoutOf } from "./world.ts";

const rows = [
	{
		name: "U+2028 inside a record does not split it",
		carried: "",
		chunk: '{"text":"a\u2028b"}\n',
		expected: { lines: ['{"text":"a\u2028b"}'], rest: "" },
	},
	{
		name: "U+2029 inside a record does not split it",
		carried: "",
		chunk: '{"text":"a\u2029b"}\n{"n":2}\n',
		expected: { lines: ['{"text":"a\u2029b"}', '{"n":2}'], rest: "" },
	},
	{
		name: "a CR before the LF is dropped",
		carried: "",
		chunk: '{"n":1}\r\n{"n":2}\n',
		expected: { lines: ['{"n":1}', '{"n":2}'], rest: "" },
	},
	{
		name: "a record split across chunks waits for its LF",
		carried: "",
		chunk: '{"n":1}\n{"te',
		expected: { lines: ['{"n":1}'], rest: '{"te' },
	},
	{
		name: "the carried part joins the next chunk",
		carried: '{"te',
		chunk: 'xt":"x"}\n',
		expected: { lines: ['{"text":"x"}'], rest: "" },
	},
	{
		name: "a chunk with no LF yields no line",
		carried: '{"a"',
		chunk: ":1",
		expected: { lines: [], rest: '{"a":1' },
	},
];

for (const { name, carried, chunk, expected } of rows) {
	test(`lfLines: ${name}`, () => {
		expect(lfLines({ carried, chunk })).toEqual(expected);
	});
}

/**
 * A pi that answers every RPC command except `FAKE_IGNORES`. It settles 200 ms after each prompt, aborted when
 * `FAKE_ABORTED` is set, and only then has `FAKE_TEXT` as its last assistant text; with none set it leaves `text` out,
 * as pi does.
 */
const fakePi = `#!/usr/bin/env bun
let text;
for await (const line of console) {
	const command = JSON.parse(line);
	if (command.type === process.env.FAKE_IGNORES) continue;
	const data = {
		get_state: { sessionId: "s", sessionFile: "/s.jsonl" },
		prompt: { disposition: "queued" },
		get_last_assistant_text: { text },
	}[command.type];
	console.log(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }));
	if (command.type === "prompt") setTimeout(() => {
		text = process.env.FAKE_TEXT;
		console.log(JSON.stringify({ type: "agent_settled", aborted: process.env.FAKE_ABORTED !== undefined }));
	}, 200);
}
`;

/** Starts the fake pi as the root, with `env` added to its environment. */
const fakeRoot = (env: Readonly<Record<string, string>>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tmp = yield* fs.makeTempDirectoryScoped();
		const layout = layoutOf({ tmp, name: "fake", stamp: "20260514-101010", pid: 42, tag: "0abc12" });

		yield* Effect.forEach([layout.bin, layout.project, layout.sessions], (dir) =>
			fs.makeDirectory(dir, { recursive: true }),
		);
		yield* fs.writeFileString(`${layout.bin}/pi`, fakePi, { mode: 0o755 });

		return yield* startRoot({
			world: {
				layout,
				agentDir: tmp,
				env: { PATH: Bun.env["PATH"] ?? "", ...env },
				pi: { version: "0.0.0", path: `${layout.bin}/pi` },
				exec: () => Effect.die("unused"),
			},
			model: "a/b",
			progress: () => Effect.void,
		});
	});

const withRoot = <Value, Failure>(
	env: Readonly<Record<string, string>>,
	use: (root: Root) => Effect.Effect<Value, Failure>,
) => Effect.runPromise(Effect.flatMap(fakeRoot(env), use).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

test("prompt returns the text pi has once it settles, not before", () =>
	withRoot({ FAKE_TEXT: "ok" }, (root) =>
		Effect.gen(function* () {
			const reply = yield* root.prompt("hi");

			expect(reply).toEqual(Option.some("ok"));
		}),
	));

test("prompt returns none when pi has no assistant text", () =>
	withRoot({}, (root) =>
		Effect.gen(function* () {
			const reply = yield* root.prompt("hi");

			expect(reply).toEqual(Option.none());
		}),
	));

test("prompt returns none when pi settles aborted, even with an earlier assistant text", () =>
	withRoot({ FAKE_TEXT: "ok", FAKE_ABORTED: "1" }, (root) =>
		Effect.gen(function* () {
			const reply = yield* root.prompt("hi");

			expect(reply).toEqual(Option.none());
		}),
	));

for (const ignored of ["prompt", "get_last_assistant_text"]) {
	test(`prompt fails within its deadline when pi never answers ${ignored}`, () =>
		withRoot({ FAKE_IGNORES: ignored }, (root) =>
			Effect.gen(function* () {
				const failure = yield* Effect.flip(root.prompt("hi", "300 millis"));

				expect(failure.message).toBe('the root did not settle within 0.3 s after "hi"');
			}),
		));
}
