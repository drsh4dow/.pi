import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { asked, branchOf, opus, personal, run, system, worldOf } from "./router.fixture.ts";

const opening = [system, asked("Why does the admissions import drop rows?")];

test("a clean request goes personal while its lane log can be written", () =>
	run(
		Effect.gen(function* () {
			const routed = yield* branchOf({ world: yield* worldOf({ name: "lane-ok" }) }).send("user", opening);

			expect(personal).toContain(routed);
		}),
	));

test("a lane log that cannot be written sends the request to ent", () =>
	run(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const world = yield* worldOf({ name: "lane-blocked" });

			yield* fs.makeDirectory(`${world.home}/.local/state/pi-phi-router/lanes/lane-blocked.jsonl`, {
				recursive: true,
			});

			const routed = yield* branchOf({ world }).send("user", opening);

			expect(routed).toBe("ent");
		}),
	));

test("a session id the lane log cannot hold sends the request to ent", () =>
	run(
		Effect.gen(function* () {
			const world = { ...(yield* worldOf({ name: "lane-bad-id" })), session: "not a valid id/../x" };
			const routed = yield* branchOf({ world }).send("user", opening);

			expect(routed).toBe("ent");
		}),
	));

test("a request pi will compact after routing goes to ent, and the next one is routed as usual", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "send-compaction" });
			const branch = branchOf({ world });

			world.known = opus.contextWindow;

			const compacted = yield* branch.send("user", opening);

			world.known = 0;

			const next = yield* branch.send("user", [...opening, asked("Go on.")]);

			expect(compacted).toBe("ent");
			expect(personal).toContain(next);
		}),
	));

test("the compaction threshold is the dispatched model's window, not phi/auto's", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "small-window" });

			world.accountWindow = 200_000;
			world.known = 190_000;

			const routed = yield* branchOf({ world }).send("user", opening);

			expect(routed).toBe("ent");
		}),
	));
