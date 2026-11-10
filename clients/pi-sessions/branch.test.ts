import { afterAll, expect, test } from "bun:test";

import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { PiSessions, piSessionsLayer } from "./index.ts";

const scratch = await Effect.runPromise(
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectory()).pipe(Effect.provide(NodeServices.layer)),
);

afterAll(() =>
	Effect.runPromise(
		Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(scratch, { recursive: true })).pipe(
			Effect.provide(NodeServices.layer),
		),
	),
);

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const saved = () => {
	const session = SessionManager.create(scratch, scratch);
	const asked = session.appendMessage({ role: "user", content: "Find the bug.", timestamp: 0 });

	const answered = session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "It is in the parser." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	});

	session.appendMessage({ role: "user", content: "Now fix it.", timestamp: 0 });

	return { file: session.getSessionFile() ?? "", asked, answered };
};

const branch = (request: Parameters<(typeof PiSessions)["Service"]["branch"]>[0]) =>
	Effect.flatMap(PiSessions, (sessions) => sessions.branch(request));

const shownAs = (entry: SessionEntry) => (entry.type === "custom_message" ? entry.content : entry.id);

test("a branch copies the path to its leaf, then the note, into a new file that names its source", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { file, asked, answered } = saved();
			const note = Option.some({ customType: "owned-work", content: "delegate-3 kept running in the source." });
			const copy = yield* branch({ source: file, dir: scratch, leaf: answered, note });
			const opened = SessionManager.open(copy, scratch);

			expect(opened.getHeader()?.parentSession).toBe(file);
			expect(Arr.map(opened.getBranch(), shownAs)).toEqual([
				asked,
				answered,
				"delegate-3 kept running in the source.",
			]);
		}).pipe(Effect.provide(piSessionsLayer)),
	));

test("a branch leaves its source as it was", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { file, answered } = saved();
			const before = yield* Effect.promise(() => Bun.file(file).text());

			yield* branch({ source: file, dir: scratch, leaf: answered, note: Option.none() });

			const after = yield* Effect.promise(() => Bun.file(file).text());

			expect(after).toBe(before);
		}).pipe(Effect.provide(piSessionsLayer)),
	));
