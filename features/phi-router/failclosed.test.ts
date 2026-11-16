import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { asked, branchOf, personal, run, system, worldOf } from "./router.fixture.ts";

const opening = [system, asked("Why does the admissions import drop rows?")];

test("a clean request goes personal while its lane log can be written", () =>
	run(
		Effect.gen(function* () {
			const routed = yield* (yield* branchOf({ world: yield* worldOf({ name: "lane-ok" }) })).send("user", opening);

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

			const routed = yield* (yield* branchOf({ world })).send("user", opening);

			expect(routed).toBe("ent");
		}),
	));

test("a session id the lane log cannot hold sends the request to ent", () =>
	run(
		Effect.gen(function* () {
			const world = { ...(yield* worldOf({ name: "lane-bad-id" })), session: "not a valid id/../x" };
			const routed = yield* (yield* branchOf({ world })).send("user", opening);

			expect(routed).toBe("ent");
		}),
	));
