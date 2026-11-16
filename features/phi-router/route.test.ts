import { expect, test } from "bun:test";

import type { Message } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { sha256 } from "./policy/digest.ts";
import { homeOf } from "./route.ts";
import {
	asked,
	branchOf,
	catOutput,
	syntheticChart,
	done,
	lanesOf,
	overloadedOn,
	personal,
	phiState,
	ranCat,
	rateLimitedOn,
	run,
	screenshot,
	stateEntry,
	system,
	worldOf,
} from "./router.fixture.ts";

const opening = [system, asked("Why does the admissions import drop rows?")];

test("a clean session stays on one personal account, its home, for every request", () =>
	run(
		Effect.gen(function* () {
			const branch = branchOf({ world: yield* worldOf({ name: "clean" }) });
			const home = yield* branch.send("user", opening);
			const read = [...opening, ranCat(home), catOutput("export const parse = (text: string) => text;")];
			const later = yield* branch.send("continuation", read);
			const next = yield* branch.send("user", [...read, done(home), asked("Now add a test.")]);

			expect(personal).toContain(home);
			expect([later, next]).toEqual([home, home]);
		}),
	));

test("a tool result with PHI sends the request to ent", () =>
	run(
		Effect.gen(function* () {
			const branch = branchOf({ world: yield* worldOf({ name: "phi-read" }) });
			const home = yield* branch.send("user", opening);
			const afterRead = yield* branch.send("continuation", [...opening, ranCat(home), catOutput(syntheticChart)]);

			expect(personal).toContain(home);
			expect(afterRead).toBe("ent");
		}),
	));

test("the same tool result stays personal when phi-router.json registers its digest as a fixture", () =>
	run(
		Effect.gen(function* () {
			const digest = sha256(syntheticChart);
			const settings = Option.some(`{ "mode": "enforce", "fixtures": ["${digest}"] }`);
			const branch = branchOf({ world: yield* worldOf({ name: "fixture", settings }) });
			const home = yield* branch.send("user", opening);
			const afterRead = yield* branch.send("continuation", [...opening, ranCat(home), catOutput(syntheticChart)]);

			expect(personal).toContain(home);
			expect(afterRead).toBe(home);
		}),
	));

test("a direct request, such as a compaction summary, goes to ent unscanned", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "direct" });
			const sent = yield* branchOf({ world }).send("direct", opening);

			expect(sent).toBe("ent");
			expect(world.judgeCalls).toEqual([]);
		}),
	));

test("a 429 moves the retry to the other personal account, and a second 429 to ent", () =>
	run(
		Effect.gen(function* () {
			const branch = branchOf({ world: yield* worldOf({ name: "rate-limit" }) });
			const home = yield* branch.send("user", opening);
			const other = yield* branch.send("retry", opening, rateLimitedOn(home));
			const third = yield* branch.send("retry", opening, rateLimitedOn(other));

			expect(personal).toContain(other);
			expect(other).not.toBe(home);
			expect(third).toBe("ent");
		}),
	));

test("a retry after a failure on ent stays on ent, even when the content is clean", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "ent-failure" });
			const branch = branchOf({ world });

			world.verdict = "error";

			const unsure = yield* branch.send("user", opening);

			world.verdict = "judge";

			const retried = yield* branch.send("retry", opening, overloadedOn("ent"));

			expect([unsure, retried]).toEqual(["ent", "ent"]);
		}),
	));

const summaryOf = (text: string): Message =>
	asked(
		`The conversation history before this point was compacted into the following summary:\n<summary>\n${text}\n</summary>`,
	);

test("after a compaction the summary is scanned: a clean one stays personal, one carrying PHI goes to ent", () =>
	run(
		Effect.gen(function* () {
			const branch = branchOf({ world: yield* worldOf({ name: "compaction" }) });
			const home = yield* branch.send("user", [...opening, done("ultra-a"), asked("Add a test.")]);
			const clean = [system, summaryOf("The parser was renamed."), asked("Now add docs.")];
			const afterClean = yield* branch.send("user", clean);
			const leaked = [system, summaryOf(`Debugged the import of: ${syntheticChart}`), asked("Now add docs.")];
			const afterLeak = yield* branch.send("user", leaked);
			const after = yield* branch.send("user", [...clean, done("ent"), asked("Ship it.")]);

			expect([afterClean, afterLeak, after]).toEqual([home, "ent", home]);
		}),
	));

test("an image sends its request to ent, since pixels are never judged", () =>
	run(
		Effect.gen(function* () {
			const branch = branchOf({ world: yield* worldOf({ name: "image" }) });
			const withImage = yield* branch.send("user", [system, screenshot]);
			const after = yield* branch.send("user", opening);

			expect(withImage).toBe("ent");
			expect(personal).toContain(after);
		}),
	));

for (const verdict of ["error", "timeout"] as const) {
	test(`a Decisions ${verdict} sends only that request to ent`, () =>
		run(
			Effect.gen(function* () {
				const world = yield* worldOf({ name: `judge-${verdict}` });
				const branch = branchOf({ world });

				world.verdict = verdict;

				const failed = yield* branch.send("user", opening);

				world.verdict = "judge";

				const recovered = yield* branch.send("user", [...opening, done("ent"), asked("Thanks.")]);

				expect(failed).toBe("ent");
				expect(personal).toContain(recovered);
			}),
		));
}

const garbled = { cursor: "Unscanned", home: "ultra-a", limited: [{ account: "ultra-b", at: "soon" }] };

test("router state that no longer decodes is skipped, and the request routes as with none", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "malformed" });
			const sent = yield* branchOf({ world, entries: [stateEntry(phiState(garbled))] }).send("user", opening);

			expect(sent).toBe(homeOf(world.session));
		}),
	));

test("shadow, the default, dispatches ent and logs the personal account it would have taken, and no content", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "shadow", settings: Option.none() });
			const branch = branchOf({ world });
			const clean = yield* branch.send("user", opening);
			const tainted = yield* branch.send("continuation", [...opening, ranCat("ent"), catOutput(syntheticChart)]);
			const { text, lanes } = yield* lanesOf(world);

			const routes = Arr.map(lanes, ({ mode, verdict, wouldBe, dispatched }) => [
				mode,
				verdict,
				wouldBe,
				dispatched,
			]);

			expect([clean, tainted]).toEqual(["ent", "ent"]);
			expect(routes).toEqual([
				["shadow", "clean", homeOf(world.session), "ent"],
				["shadow", "tainted", "ent", "ent"],
			]);
			expect(text).not.toContain("Jane Roe");
			expect(text).not.toContain("admissions");
		}),
	));

const forced = [
	{ name: "force-baa", slug: "force-baa", settings: '{ "mode": "force-baa" }' },
	{ name: "a baaRepos folder", slug: "baa-repo", settings: '{ "mode": "enforce", "baaRepos": ["REPO/"] }' },
	{ name: "settings that do not parse", slug: "bad-settings", settings: '{ "mode": "enforce", ' },
];

for (const { name, slug, settings } of forced) {
	test(`${name} dispatches ent without a scan`, () =>
		run(
			Effect.gen(function* () {
				const world = yield* worldOf({ name: `forced-${slug}`, settings: Option.some(settings) });
				const sent = yield* branchOf({ world }).send("user", opening);

				expect(sent).toBe("ent");
				expect(world.judgeCalls).toEqual([]);
			}),
		));
}
