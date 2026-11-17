import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Str from "effect/String";

import { Fixtures, sha256 } from "./digest.ts";
import { expectJudged, judgeAll, pieceOf, type Question, run, type Script } from "./engine.fixture.ts";
import { Finding, Judge, type Piece, Verdict, verdictsFor } from "./engine.ts";
import { Synthetic } from "./synthetic.ts";

const cleared = [Verdict.Cleared({ by: "judge" })];

const sealedAs = (finding: Finding) => [Verdict.Sealed({ finding })];

type Case = readonly [
	name: string,
	script: Script,
	verdicts: ReadonlyArray<Verdict>,
	questions: ReadonlyArray<Question>,
];

const userCases: ReadonlyArray<Case> = [
	["0.1 clears without a kind call", { score: () => 0.1 }, cleared, ["identifier"]],
	["0.3 with none clears", { score: () => 0.3, kind: () => "none" }, cleared, ["identifier", "kind"]],
	[
		"0.3 with a named kind seals",
		{ score: () => 0.3, kind: () => "patient-name" },
		sealedAs(Finding.Judge({ score: 0.3, kind: "patient-name" })),
		["identifier", "kind"],
	],
	[
		"0.6 seals, labelled by the kind call",
		{ score: () => 0.6, kind: () => "ssn" },
		sealedAs(Finding.Judge({ score: 0.6, kind: "ssn" })),
		["identifier", "kind"],
	],
	[
		"0.6 seals unlabelled when the kind call refuses",
		{ score: () => 0.6, kind: () => "refused" },
		sealedAs(Finding.Judge({ score: 0.6, kind: "unlabelled" })),
		["identifier", "kind"],
	],
	[
		"a refused kind call in the band seals as a failure",
		{ score: () => 0.3, kind: () => "refused" },
		sealedAs(Finding.Failure({ why: "judge-refused" })),
		["identifier", "kind"],
	],
	[
		"a judge error seals as a failure, asked once",
		{ score: () => "error" },
		sealedAs(Finding.Failure({ why: "judge-error" })),
		["identifier"],
	],
];

test.each(userCases)("a user message: %s", (_name, script, verdicts, questions) =>
	run(expectJudged(pieceOf("Follow-up for the import job."), script, { verdicts, questions })),
);

const failingOnce = () => {
	let calls = 0;

	return () => {
		calls += 1;

		return calls === 1 ? "error" : 0.1;
	};
};

const systemCases: ReadonlyArray<Case> = [
	["0.3 clears without a kind call", { score: () => 0.3, kind: () => "patient-name" }, cleared, ["identifier"]],
	["0.6 with none clears", { score: () => 0.6, kind: () => "none" }, cleared, ["identifier", "kind"]],
	[
		"0.6 with a named kind seals",
		{ score: () => 0.6, kind: () => "patient-name" },
		sealedAs(Finding.Judge({ score: 0.6, kind: "patient-name" })),
		["identifier", "kind"],
	],
	["a failure is retried once", { score: failingOnce() }, cleared, ["identifier", "identifier"]],
	[
		"a failure on the retry seals",
		{ score: () => "error" },
		sealedAs(Finding.Failure({ why: "judge-error" })),
		["identifier", "identifier"],
	],
	[
		"a kind call refused twice seals",
		{ score: () => 0.6, kind: () => "refused" },
		sealedAs(Finding.Failure({ why: "judge-refused" })),
		["identifier", "kind", "kind"],
	],
];

test.each(systemCases)("a system part: %s", (_name, script, verdicts, questions) =>
	run(expectJudged({ ...pieceOf("You are a coding agent."), kind: "system" }, script, { verdicts, questions })),
);

const sealing: Script = { score: () => 0.9, kind: () => "patient-name" };

const ssnHit = sealedAs(Finding.Rule({ rule: "ssn", kind: "ssn" }));

test("a rule hit seals without a judge call", () =>
	run(expectJudged(pieceOf("Patient SSN 078-05-1120 on file"), sealing, { verdicts: ssnHit, questions: [] })));

test("a piece is read after its seam, so an SSN cut across two messages hits the rule", () =>
	run(
		expectJudged({ ...pieceOf("23 on file"), seam: "Patient SSN 412-56-78" }, sealing, {
			verdicts: ssnHit,
			questions: [],
		}),
	));

test("a personal reply is never judged, but a valid SSN in it still seals", () =>
	run(
		Effect.gen(function* () {
			const clean: Piece = { ...pieceOf("Marisol Quintero's record is ready."), kind: "reply-personal" };
			const ssn: Piece = { ...pieceOf("Use 078-05-1120 for the test."), kind: "reply-personal" };

			yield* expectJudged(clean, sealing, { verdicts: [Verdict.Cleared({ by: "rules-only" })], questions: [] });
			yield* expectJudged(ssn, sealing, { verdicts: ssnHit, questions: [] });
		}),
	));

const sealsOn = (marker: string): Script => ({
	score: ({ piece }) => (Str.includes(marker)(piece) ? 0.9 : 0.1),
	kind: () => "patient-name",
});

test("a listed synthetic identity is blanked, and the rest of the piece is still judged", () =>
	run(
		Effect.gen(function* () {
			const listed = pieceOf("member 078-05-1120 on client STG-0042 failed eligibility");
			const named = pieceOf("078-05-1120 belongs to Marisol Quintero");
			const judged = judgeAll({ pieces: [listed, named], script: sealsOn("Quintero") });
			const synthetic = { exact: ["078-05-1120"], prefixes: ["STG-"] };
			const { found, asked } = yield* Effect.provideService(judged, Synthetic, synthetic);

			expect(found).toEqual([
				[listed.key, Verdict.Cleared({ by: "judge" })],
				[named.key, Verdict.Sealed({ finding: Finding.Judge({ score: 0.9, kind: "patient-name" }) })],
			]);

			expect(Arr.map(asked, ({ input }) => input.piece)).toContain(
				"member [synthetic-id] on client [synthetic-id] failed eligibility",
			);
		}),
	));

test("a registered fixture part is skipped, and a piece of nothing else clears without the judge", () =>
	run(
		Effect.gen(function* () {
			const chart = "Patient Marisol Quintero, SSN 078-05-1120";
			const alone = pieceOf(chart);
			const beside = { ...pieceOf("why does this fail?"), texts: [chart, "why does this fail?"] };
			const judged = judgeAll({ pieces: [alone, beside], script: { score: () => 0.1 } });
			const { found, asked } = yield* Effect.provideService(judged, Fixtures, new Set([sha256(chart)]));

			expect(found).toEqual([
				[alone.key, Verdict.Cleared({ by: "fixture" })],
				[beside.key, Verdict.Cleared({ by: "judge" })],
			]);

			expect(Arr.map(asked, ({ input }) => input.piece)).toEqual(["why does this fail?"]);
		}),
	));

const image = (index: number) => ({ mimeType: "image/png", data: `iVBORw0KGgo${String(index)}` });

const sealsLoneImage: Script = { ...sealing, score: ({ images }) => (images.length === 1 ? 0.9 : 0.1) };

test("images reach the judge, 128 to a call, and a seal on any call seals the piece", () =>
	run(
		Effect.gen(function* () {
			const screenshot = { ...pieceOf("Why is this page blank?"), images: Arr.makeBy(129, image) };
			const { found, asked, usage: spent } = yield* judgeAll({ pieces: [screenshot], script: sealsLoneImage });
			const scored = Arr.filter(asked, ({ question }) => question === "identifier");

			expect(Arr.map(scored, ({ input }) => [input.piece, input.images])).toEqual([
				["Why is this page blank?", Arr.makeBy(128, image)],
				["Why is this page blank?", [image(128)]],
			]);

			expect(found).toEqual([
				[screenshot.key, Verdict.Sealed({ finding: Finding.Judge({ score: 0.9, kind: "patient-name" }) })],
			]);

			expect(spent).toEqual({ calls: 3, inputTokens: 30, cost: 0.003, ms: 15 });
		}),
	));

test("known keys and repeated keys are judged at most once", () =>
	run(
		Effect.gen(function* () {
			const old = pieceOf("an old message");
			const fresh = pieceOf("a new message");

			const { found, asked } = yield* judgeAll({
				pieces: [old, fresh, fresh],
				script: { score: () => 0.1 },
				known: (key) => key === old.key,
			});

			expect(found).toEqual([[fresh.key, Verdict.Cleared({ by: "judge" })]]);
			expect(asked).toHaveLength(1);
		}),
	));

const failsOnBroken: Script = { score: ({ piece }) => (piece === "the call that breaks" ? "error" : 0.1) };

test("a judge error seals only the piece it failed on", () =>
	run(
		Effect.gen(function* () {
			const broken = pieceOf("the call that breaks");
			const fine = pieceOf("the call that works");
			const { found } = yield* judgeAll({ pieces: [broken, fine], script: failsOnBroken });

			expect(found).toEqual([
				[broken.key, Verdict.Sealed({ finding: Finding.Failure({ why: "judge-error" }) })],
				[fine.key, Verdict.Cleared({ by: "judge" })],
			]);
		}),
	));

test("a piece over the judge's size limit seals without a call", () => {
	const huge = pieceOf(Str.repeat(2_000_001)("a"));
	const tooLarge = { verdicts: sealedAs(Finding.Failure({ why: "too-large" })), questions: [] };

	return run(expectJudged(huge, { score: () => 0.1 }, tooLarge));
});

test("an interruption propagates instead of becoming a verdict", () =>
	run(
		Effect.gen(function* () {
			const interrupted = Judge.of({ identifier: () => Effect.interrupt, kind: () => Effect.interrupt });
			const judging = verdictsFor([pieceOf("a message")], () => false);
			const exit = yield* Effect.exit(Effect.provideService(judging, Judge, interrupted));

			expect(exit.pipe(Exit.hasInterrupts)).toBe(true);
		}),
	));
