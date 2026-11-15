import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { JudgeFailed, Phi, ScanResult, TaintedCursor, Unscannable, type JudgeInput } from "./index.ts";
import { assistant, clearedCursor, scanWith, system, user } from "./judge.fixture.ts";

const prompt = system("You are a coding agent.");
const question = user("Why does the build fail?");
const reply = assistant("The lockfile is stale.");
const none = { newChars: 0, judgeCalls: 0, judgeMs: 0 };

const answering = (pPhi: number) => () => Effect.succeed({ pPhi, category: Option.some("mrn" as const) });

const failing = (why: "timeout" | "error") => () => Effect.fail(JudgeFailed.make({ why }));

const screenshot = {
	role: "user" as const,
	parts: [{ kind: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" }],
};

const run = (body: Effect.Effect<void>) => Effect.runPromise(body);

const promptCall = { seen: "", fresh: "[system] You are a coding agent." };

test("a first scan judges the system turns and the conversation in separate calls", () =>
	run(
		Effect.gen(function* () {
			const { result, asked } = yield* scanWith({ transcript: [prompt, question, reply] });

			expect(ScanResult.$is("Clean")(result)).toBe(true);
			expect(asked).toEqual([
				promptCall,
				{ seen: "", fresh: "[user] Why does the build fail?\n[assistant] The lockfile is stale." },
			]);
		}),
	));

test("an extended transcript sends only its new turns as fresh, with the cleared conversation as seen", () =>
	run(
		Effect.gen(function* () {
			const cursor = yield* clearedCursor([prompt, question, reply]);
			const { asked } = yield* scanWith({ transcript: [prompt, question, reply, user("Fix it.")], cursor });

			expect(asked).toEqual([
				{
					seen: "[user] Why does the build fail?\n[assistant] The lockfile is stale.",
					fresh: "[user] Fix it.",
				},
			]);
		}),
	));

test("a conversation turn edited after it was cleared rescans the conversation, not the unchanged system turns", () =>
	run(
		Effect.gen(function* () {
			const cursor = yield* clearedCursor([prompt, question, reply]);
			const edited = [prompt, user("Why does the test fail?"), reply, user("Fix it.")];
			const { asked } = yield* scanWith({ transcript: edited, cursor });

			expect(asked).toEqual([
				{
					seen: "",
					fresh: "[user] Why does the test fail?\n[assistant] The lockfile is stale.\n[user] Fix it.",
				},
			]);
		}),
	));

test("a transcript shorter than the cleared prefix, as after compaction, rescans the conversation", () =>
	run(
		Effect.gen(function* () {
			const cursor = yield* clearedCursor([prompt, question, reply]);
			const { asked } = yield* scanWith({ transcript: [prompt, user("Summary: a stale lockfile.")], cursor });

			expect(asked).toEqual([{ seen: "", fresh: "[user] Summary: a stale lockfile." }]);
		}),
	));

test("a retry with nothing new returns Clean with the same cursor and no judge call", () =>
	run(
		Effect.gen(function* () {
			const cursor = yield* clearedCursor([prompt, question, reply]);
			const { result, asked } = yield* scanWith({ transcript: [prompt, question, reply], cursor });

			expect(result).toEqual(ScanResult.Clean({ cursor, stats: none }));
			expect(asked).toEqual([]);
		}),
	));

test("a tainted cursor stays tainted without a judge call", () =>
	run(
		Effect.gen(function* () {
			const taint = Phi.make({ detector: "judge", category: "name" });
			const cursor = TaintedCursor.make({ taint });
			const { result, asked } = yield* scanWith({ transcript: [prompt, question], cursor });

			expect(result).toEqual(ScanResult.Tainted({ taint, fresh: false, stats: none }));
			expect(asked).toEqual([]);
		}),
	));

test("an image taints the branch without a judge call", () =>
	run(
		Effect.gen(function* () {
			const { result, asked } = yield* scanWith({ transcript: [prompt, question, screenshot] });

			expect(result).toEqual(
				ScanResult.Tainted({ taint: Unscannable.make({ what: "image" }), fresh: true, stats: none }),
			);
			expect(asked).toEqual([]);
		}),
	));

for (const [why, unsure] of [
	["timeout", "judge-timeout"],
	["error", "judge-error"],
] as const) {
	test(`a judge ${why} is Unsure, which carries no cursor, so the caller keeps its old one`, () =>
		run(
			Effect.gen(function* () {
				const { result } = yield* scanWith({ transcript: [prompt, question], answer: failing(why) });

				expect(ScanResult.$is("Unsure")(result) && result.why).toBe(unsure);
				expect(ScanResult.$is("Unsure")(result) && result.stats.judgeCalls).toBe(2);
				expect("cursor" in result).toBe(false);
			}),
		));
}

test("a judge answer at the threshold taints with the judge's category", () =>
	run(
		Effect.gen(function* () {
			const { result } = yield* scanWith({ transcript: [prompt, question], answer: answering(0.2) });

			expect(ScanResult.$is("Tainted")(result) && result.taint).toEqual(
				Phi.make({ detector: "judge", category: "mrn" }),
			);
		}),
	));

test("a judge answer below the threshold is Clean and counts the fresh characters", () =>
	run(
		Effect.gen(function* () {
			const { result } = yield* scanWith({ transcript: [question], answer: answering(0.19) });

			expect(ScanResult.$is("Clean")(result) && result.stats.newChars).toBe(
				"[user] Why does the build fail?".length,
			);
			expect(ScanResult.$is("Clean")(result) && result.stats.judgeCalls).toBe(1);
		}),
	));

const associating = ({ seen, fresh }: JudgeInput) => {
	const both = `${seen}${fresh}`;
	const pPhi = Str.includes("Marisol Quintero")(both) && Str.includes("has HIV")(both) ? 0.9 : 0;

	return Effect.succeed({ pPhi, category: Option.none() });
};

test("a transcript beyond the judge's limit is Unsure with no judge call, never judged in pieces", () =>
	run(
		Effect.gen(function* () {
			const named = user(`Marisol Quintero${Str.repeat(1_999_972)(" ")}`);
			const cursor = yield* clearedCursor([named]);

			const { result, asked } = yield* scanWith({
				transcript: [named, user("has HIV")],
				cursor,
				answer: associating,
			});

			expect(ScanResult.$is("Unsure")(result) && result.why).toBe("too-large");
			expect(asked).toEqual([]);
		}),
	));

test("a transcript exactly at the judge's limit is one call", () =>
	run(
		Effect.gen(function* () {
			const fresh = "[user] Why does the build fail?";
			const { asked } = yield* scanWith({ transcript: [question], maxChars: fresh.length });

			expect(asked).toEqual([{ seen: "", fresh }]);
		}),
	));
