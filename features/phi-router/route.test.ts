import { expect, test } from "bun:test";

import { type Message } from "@earendil-works/pi-ai";
import { type CompactionEntry, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { guard, type Lookup } from "./border.ts";
import { compactionHead } from "./dispatch.ts";
import { Judge } from "./policy/engine.ts";
import { stubs } from "./policy/policy.ts";
import { accountFor, decide, homeOf } from "./route.ts";
import {
	asked,
	branchOf,
	catOutput,
	done,
	lanesOf,
	overloadedOn,
	personal,
	ranCat,
	rateLimitedOn,
	run,
	scriptedJudge,
	ssnRecord,
	syntheticChart,
	system,
	worldOf,
} from "./router.fixture.ts";

const question = "Why does the admissions import drop rows?";

const opening = [system, asked(question)];

/** What a personal account receives of `messages`, message by message. */
const viewOf = (messages: ReadonlyArray<Message>, lookup: Lookup) =>
	Result.getOrThrow(guard({ messages, lookup })).messages;

/** A session that read a record with a valid SSN, and the request after it. */
const sealedSession = (name: string) =>
	Effect.gen(function* () {
		const world = yield* worldOf({ name });
		const branch = yield* branchOf({ world });
		const home = homeOf(world.session);
		const read = [...opening, ranCat(home), catOutput(ssnRecord)];
		const next = [...read, done("ent"), asked("Now add a test.")];
		const lanes = [yield* branch.send("user", opening), yield* branch.send("continuation", read)];

		return { world, branch, home, read, next, lanes };
	});

test("a tool result with a valid SSN goes to ent, and the next request goes home with that result stubbed", () =>
	run(
		Effect.gen(function* () {
			const { world, branch, home, next, lanes } = yield* sealedSession("ssn");
			const after = yield* branch.send("user", next);
			const view = viewOf(next, branch.book().lookup);

			expect([...lanes, after]).toEqual([home, "ent", home]);
			expect(view[3]).toEqual({ ...catOutput(stubs.sealed) });
			expect(view[1]).toEqual(next[1]);
			expect(world.notices).toEqual(["One message held patient identifiers and was handled only on ent."]);
		}),
	));

test("a retry of a sealed request and a repeated read of the sealed content go to ent", () =>
	run(
		Effect.gen(function* () {
			const { branch, home, read, next } = yield* sealedSession("repeat");
			const retried = yield* branch.send("retry", read);
			const after = yield* branch.send("user", next);
			const reread = yield* branch.send("continuation", [...next, ranCat(home), catOutput(ssnRecord)]);

			expect([retried, after, reread]).toEqual(["ent", home, "ent"]);
		}),
	));

test("a tool result the judge flags goes to ent, and a clean one stays home", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "judged" });
			const branch = yield* branchOf({ world });
			const home = homeOf(world.session);
			const clean = yield* branch.send("continuation", [...opening, ranCat(home), catOutput("export const x = 1;")]);
			const flagged = yield* branch.send("continuation", [...opening, ranCat(home), catOutput(syntheticChart)]);

			expect([clean, flagged]).toEqual([home, "ent"]);
		}),
	));

test("an ent reply right after sealed content is judged beside its stub, so the next request goes home", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "after-seal" });
			const branch = yield* branchOf({ world });
			const home = homeOf(world.session);
			const read = [...opening, ranCat(home), catOutput(syntheticChart)];
			const sealed = yield* branch.send("continuation", read);
			const after = yield* branch.send("user", [...read, done("ent"), asked("Now add a test.")]);

			expect([sealed, after]).toEqual(["ent", home]);
		}),
	));

test("a direct request goes to ent with nothing judged", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "direct" });
			const sent = yield* (yield* branchOf({ world })).send("direct", opening);

			expect(sent).toBe("ent");
			expect(world.judged).toEqual([]);
		}),
	));

test("a pinned session goes to ent with nothing judged, and after unpin the pinned stretch is judged", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "pin" });
			const branch = yield* branchOf({ world });

			branch.pin(true);

			const pinned = yield* branch.send("user", opening);
			const judgedWhilePinned = world.judged.length;

			branch.pin(false);

			const unpinned = yield* branch.send("user", [...opening, done("ent"), asked("Go on.")]);

			expect([pinned, unpinned]).toEqual(["ent", homeOf(world.session)]);
			expect(judgedWhilePinned).toBe(0);
			expect(world.judged).toContain(question);
		}),
	));

test("shadow, the default, dispatches ent and logs the account enforce would take, and no content", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "shadow", settings: Option.none() });
			const branch = yield* branchOf({ world });
			const sent = yield* branch.send("user", opening);
			const { text, lanes } = yield* lanesOf(world);

			expect(sent).toBe("ent");
			expect(
				Arr.map(lanes, (line) => (line.type === "route" ? [line.mode, line.wouldBe, line.dispatched] : [])),
			).toEqual([["shadow", homeOf(world.session), "ent"]]);
			expect(text).not.toContain("admissions");
		}),
	));

test("a 429 moves the retry to the other personal account, and a failure on ent keeps the retry on ent", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "failover" });
			const branch = yield* branchOf({ world });
			const home = homeOf(world.session);
			const other = yield* branch.send("retry", opening, rateLimitedOn(home));
			const afterEnt = yield* branch.send("retry", opening, overloadedOn("ent"));

			expect(personal).toContain(other);
			expect(other).not.toBe(home);
			expect(afterEnt).toBe("ent");
		}),
	));

test("the personal lane skips a limited or unusable account, and ent never fails over to one", () => {
	const choice = {
		lane: "personal" as const,
		home: "ultra-a" as const,
		limited: () => false,
		usable: () => true,
		failedOnBaa: false,
	};

	expect(accountFor(choice)).toBe("ultra-a");
	expect(accountFor({ ...choice, limited: (account) => account === "ultra-a" })).toBe("ultra-b");
	expect(accountFor({ ...choice, usable: (account) => account === "ent" })).toBe("ent");
	expect(accountFor({ ...choice, failedOnBaa: true })).toBe("ent");
	expect(accountFor({ ...choice, lane: "ent" })).toBe("ent");
});

test("a judge that dies sends the request to ent", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "judge-dies" });
			const branch = yield* branchOf({ world });

			world.judge = "dies";

			const account = yield* branch.send("user", opening);

			expect(account).toBe("ent");
		}),
	));

test("a failed judgment seals only its piece: the request goes to ent and the next one home", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "judge-errors" });
			const branch = yield* branchOf({ world });

			world.judge = "errors";

			const failed = yield* branch.send("user", opening);

			world.judge = "answers";

			const next = yield* branch.send("user", [...opening, done("ent"), asked("Thanks.")]);

			expect([failed, next]).toEqual(["ent", homeOf(world.session)]);
		}),
	));

test("verdicts survive a restart: the folded book routes as before, with no judge calls", () =>
	run(
		Effect.gen(function* () {
			const { world, branch, home, next } = yield* sealedSession("restart");
			const before = yield* branch.send("user", next);

			yield* branch.restart;

			const calls = world.judged.length;
			const after = yield* branch.send("user", next);

			expect([before, after]).toEqual([home, home]);
			expect(world.judged.length).toBe(calls);
			expect(viewOf(next, branch.book().lookup)[3]).toEqual({ ...catOutput(stubs.sealed) });
		}),
	));

/** A session pi compacted into a summary that names a patient, and its compaction entry. */
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
