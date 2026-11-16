import { expect, test } from "bun:test";

import { type CompactionEntry, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { guard } from "./border.ts";
import { Judge } from "./policy/engine.ts";
import { compactionHead, decide, homeOf } from "./route.ts";
import { asked, branchOf, done, run, scriptedJudge, syntheticChart, system, worldOf } from "./router.fixture.ts";

const question = "Why does the admissions import drop rows?";

const compacted = () => {
	const session = SessionManager.inMemory("/work");

	session.appendMessage(system);
	session.appendMessage(asked(question));
	session.appendCompaction(`Debugged the import of: ${syntheticChart}`, session.appendMessage(done("ultra-a")), 1000);

	const entry = Arr.findFirst(session.getEntries(), (found): found is CompactionEntry => found.type === "compaction");

	return { session, entry };
};

test("the compaction judge keys the summary as the next request carries it", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "compaction" });
			const book = (yield* branchOf({ world })).book();
			const { session, entry } = compacted();
			const compaction = yield* Effect.fromOption(entry);

			const judged = yield* decide({
				messages: compactionHead(compaction),
				reason: "continuation",
				book,
				hold: Option.none(),
			}).pipe(Effect.provideService(Judge, scriptedJudge(world)));

			const next = convertToLlm(session.buildSessionProjection().messages);
			const { report } = Result.getOrThrow(guard({ messages: next, lookup: book.lookup }));

			expect(judged.why).toBe("sealed");
			expect(report.stubbedSealed).toBe(1);
		}),
	));

const afterSealedSummary = ({ name, replies }: { readonly name: string; readonly replies: ReadonlyArray<string> }) =>
	Effect.gen(function* () {
		const world = yield* worldOf({ name });
		const { session, entry } = compacted();
		const compaction = yield* Effect.fromOption(entry);

		for (const provider of replies) {
			session.appendMessage(done(provider));
		}

		const branch = yield* branchOf({ world, entries: session.getBranch() });

		yield* decide({
			messages: compactionHead(compaction),
			reason: "continuation",
			book: branch.book(),
			hold: Option.none(),
		}).pipe(Effect.provideService(Judge, scriptedJudge(world)));

		const next = [...convertToLlm(session.buildSessionProjection().messages), asked("Continue from the summary.")];

		return { home: homeOf(world.session), lane: yield* branch.send("user", next) };
	});

test("a sealed compaction summary goes to ent on each request until ent has answered after it", () =>
	run(
		Effect.gen(function* () {
			const manual = yield* afterSealedSummary({ name: "summary-manual", replies: [] });
			const threshold = yield* afterSealedSummary({ name: "summary-threshold", replies: ["ultra-a"] });
			const answered = yield* afterSealedSummary({ name: "summary-answered", replies: ["ent"] });

			expect([manual.lane, threshold.lane, answered.lane]).toEqual(["ent", "ent", answered.home]);
		}),
	));
