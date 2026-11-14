import { afterAll, expect, test } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Str from "effect/String";

import { makeReader } from "./index.ts";

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

let made = 0;

/** A fresh sessions folder per test: the root's session goes in it, and every delegate's in `delegates/` below. */
const sessionsDir = () => {
	made += 1;

	const dir = `${scratch}/${String(made)}`;

	return { dir, delegates: `${dir}/delegates` };
};

const usageOf = (usd: number) => ({
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd },
});

const open = (dir: string) => SessionManager.create("/work", dir);

/** A session file appears at its first reply, so every session here starts with one. */
const reply = (session: SessionManager, usd: number) =>
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "anthropic-messages",
		provider: "ultra-a",
		model: "claude-opus-5-5",
		usage: usageOf(usd),
		stopReason: "stop",
		timestamp: 0,
	});

const startDelegate = (parent: SessionManager, child: SessionManager, name: string) =>
	parent.appendCustomEntry("owned-work", {
		type: "delegate-started",
		handle: "delegate-1",
		name,
		child_session_id: child.getSessionId(),
	});

const readerOf = (root: SessionManager, delegates: string) =>
	makeReader({ root: root.getSessionFile() ?? "", delegates });

const run = <Value>(effect: Effect.Effect<Value, PlatformError.PlatformError, FileSystem.FileSystem>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

test("the label holds the session's own spend and each delegate's, at every level", () =>
	run(
		Effect.gen(function* () {
			const { dir, delegates } = sessionsDir();

			const { root, child, grandchild } = { root: open(dir), child: open(delegates), grandchild: open(delegates) };

			reply(root, 1.5);
			startDelegate(root, child, "review auth");
			reply(root, 0.25);
			reply(child, 0.5);
			startDelegate(child, grandchild, "scout docs");
			reply(grandchild, 0.125);

			const label = yield* readerOf(root, delegates).read;

			expect(label).toEqual({
				own: 1.75,
				delegates: [
					{ name: "review auth", usd: 0.5 },
					{ name: "scout docs", usd: 0.125 },
				],
			});
		}),
	));

test("compactions and branch summaries count, since each one calls the model", () =>
	run(
		Effect.gen(function* () {
			const { dir, delegates } = sessionsDir();
			const root = SessionManager.create("/work", dir);
			const first = reply(root, 1);

			root.appendCompaction("summary", first, 1000, undefined, false, usageOf(0.5));
			root.branchWithSummary(first, "branch summary", undefined, false, usageOf(0.25));

			const label = yield* readerOf(root, delegates).read;

			expect(label.own).toBe(1.75);
		}),
	));

test("a cache-warm call counts, since it calls the model", () =>
	run(
		Effect.gen(function* () {
			const { dir, delegates } = sessionsDir();
			const root = SessionManager.create("/work", dir);

			reply(root, 1);
			root.appendUsage("cache_warm", "ultra-a", "claude-opus-5-5", usageOf(0.125));

			const label = yield* readerOf(root, delegates).read;

			expect(label.own).toBe(1.125);
		}),
	));

/** A session that spent $5 and started a delegate that spent $1, and returns the id of its last reply. */
const sourceWithHistory = (dir: string, delegates: string) => {
	const source = SessionManager.create("/work", dir);
	const earlier = SessionManager.create("/work", delegates);

	reply(source, 2);
	startDelegate(source, earlier, "earlier work");
	reply(earlier, 1);

	return { source, leaf: reply(source, 3) };
};

test("a fork counts only what it spent after the fork, not its source's history", () =>
	run(
		Effect.gen(function* () {
			const { dir, delegates } = sessionsDir();
			const { source, leaf } = sourceWithHistory(dir, delegates);

			// A real fork comes at least a keystroke after the last reply, never in the same millisecond.
			yield* Effect.sleep("2 millis");

			const fork = SessionManager.open(source.getSessionFile() ?? "", dir);

			fork.createBranchedSession(leaf);
			reply(fork, 0.5);

			const label = yield* readerOf(fork, delegates).read;

			expect(label).toEqual({ own: 0.5, delegates: [] });
		}),
	));

test("a later read picks up new replies and a delegate whose file appears after it started", () =>
	run(
		Effect.gen(function* () {
			const { dir, delegates } = sessionsDir();
			const { root, child } = { root: open(dir), child: open(delegates) };
			const reader = readerOf(root, delegates);

			reply(root, 1);
			startDelegate(root, child, "slow starter");

			const before = yield* reader.read;

			reply(root, 0.5);
			reply(child, 0.25);

			const after = yield* reader.read;

			expect([before, after]).toEqual([
				{ own: 1, delegates: [{ name: "slow starter", usd: 0 }] },
				{ own: 1.5, delegates: [{ name: "slow starter", usd: 0.25 }] },
			]);
		}),
	));

/** A compaction line with a timestamp after any header, as pi writes it, minus the fields the reader never reads. */
const compactionLine =
	'{"type":"compaction","id":"c1","timestamp":"2999-01-01T00:00:00.000Z","usage":{"cost":{"total":0.5}}}';

test("a line still being written counts once it ends", () =>
	run(
		Effect.gen(function* () {
			const { dir, delegates } = sessionsDir();
			const root = SessionManager.create("/work", dir);
			const reader = readerOf(root, delegates);

			const append = (text: string) =>
				Effect.flatMap(FileSystem.FileSystem, (fs) =>
					fs.writeFileString(root.getSessionFile() ?? "", text, { flag: "a" }),
				);

			reply(root, 1);
			yield* append(Str.slice(0, 40)(compactionLine));

			const halfway = yield* reader.read;

			yield* append(`${Str.slice(40)(compactionLine)}\n`);

			const ended = yield* reader.read;

			expect([halfway.own, ended.own]).toEqual([1, 1.5]);
		}),
	));
