import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Static } from "typebox";

import { callerOf, continued, delegate, runtime, started } from "./brief.fixture.ts";
import type { DelegateParams } from "./brief.ts";
import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { exit, killed, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Answer, End, Launched, TurnEnds, Delivered, SpawnLevels, Pause } = Act;

const runs = Hook({ event: "run starts" });

const brief = '{"role":"leaf","goal":"Cap the retries.","instructions":"Review."}';

const rows: ReadonlyArray<Row> = [
	{
		name: "a delegate that failed on a provider error wakes with a next that names its continuation, and nothing runs it again until the parent continues it, by default after checking its last tool call",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate", name: "slice owner" }),
			Start({ kind: "delegate", name: "scout" }),
			Answer({ terminal: "t1", text: "", stopReason: "error", end: exit(0) }),
			End({ terminal: "t2", end: killed(9) }),
			TurnEnds({ expect: "continue: delegate-1 failed: errored: 429 rate limit; delegate-2 failed: oom" }),
			Delivered({
				expect: (sessionIdOf) => [
					{
						ref: "delegate-1",
						kind: "delegate",
						name: "slice owner",
						session: sessionIdOf("t1"),
						outcome: { status: "failed", reason: "errored", detail: "429 rate limit" },
						next: 'call delegate with continues "delegate-1" to run it again in its own session',
					},
					{
						ref: "delegate-2",
						kind: "delegate",
						name: "scout",
						session: sessionIdOf("t2"),
						outcome: { status: "failed", reason: "oom", detail: "signal 9 with no exit code" },
					},
				],
			}),
			Pause({ ms: 100 }),
			SpawnLevels({ expect: ["delegate-1 at level 2", "delegate-2 at level 2"] }),
			Start({ kind: "delegate", continues: "delegate-1" }),
			Launched({
				terminal: "t3",
				expect: (sessionIdOf) => ({
					session: sessionIdOf("t1"),
					brief,
					message:
						"You run again in your own session. If your last turn ended in a tool call, check what that call already did, such as the files it changed or the commands it started, before you run it again. Then finish your task.",
				}),
			}),
			End({ terminal: "t3", end: killed(9) }),
			TurnEnds({ expect: "continue: delegate-3 failed: oom" }),
		],
	},
	{
		name: "a finished delegate takes a follow-up in its own session, with its brief and the new message, and wakes under its name and session",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate", name: "slice owner" }),
			Launched({
				terminal: "t1",
				expect: (sessionIdOf) => ({ session: sessionIdOf("t1"), brief, message: "Review it." }),
			}),
			Answer({ terminal: "t1", text: "built", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: built" }),
			Start({ kind: "delegate", continues: "delegate-1", message: "Also update the docs." }),
			Launched({
				terminal: "t2",
				expect: (sessionIdOf) => ({ session: sessionIdOf("t1"), brief, message: "Also update the docs." }),
			}),
			End({ terminal: "t2", end: killed(9) }),
			TurnEnds({ expect: "continue: delegate-2 failed: oom" }),
			Delivered({
				expect: (sessionIdOf) => [
					{
						ref: "delegate-1",
						kind: "delegate",
						name: "slice owner",
						session: sessionIdOf("t1"),
						outcome: {
							status: "done",
							text: "built",
							cut: false,
							answer: `${sessionRoot}/delegates/${sessionIdOf("t1")}.answer.md`,
						},
					},
					{
						ref: "delegate-2",
						kind: "delegate",
						name: "slice owner",
						session: sessionIdOf("t1"),
						outcome: { status: "failed", reason: "oom", detail: "signal 9 with no exit code" },
					},
				],
			}),
		],
	},
	{
		name: "continuing a live delegate, a ref this agent never started, or work that is not a delegate is refused with the reason, before anything spawns",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate", name: "slice owner" }),
			Start({ kind: "watch" }),
			Start({
				kind: "delegate",
				continues: "delegate-1",
				refused: "delegate-1 still runs; continue it once it settles",
			}),
			Start({ kind: "delegate", continues: "delegate-9", refused: "no work is called delegate-9" }),
			Start({ kind: "delegate", continues: "watch-2", refused: "watch-2 is a watch, not a delegate" }),
			SpawnLevels({ expect: ["delegate-1 at level 2", "watch-2 at level 3"] }),
			Answer({ terminal: "t1", text: "built", end: exit(0) }),
			End({ terminal: "t2", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: built; watch-2 fired 0 (log watch.log): tail" }),
		],
	},
];

for (const row of rows) {
	test(row.name, () => Effect.runPromise(runRow(row)));
}

const outcomeOf = (call: Static<DelegateParams>) =>
	Effect.map(
		Effect.promise(() => delegate.execute("call", call, undefined, undefined, callerOf())),
		({ isError, details }) => ({
			isError,
			details,
			continued: Arr.map(continued.splice(0), ({ ref, message, group }) => ({
				ref: String(ref),
				message: Option.getOrUndefined(message),
				group: Option.getOrUndefined(group),
			})),
			started: started.splice(0),
		}),
	);

test("a continuation hands the ledger its ref, message and group, and starts no fresh delegate", () =>
	runtime.runPromise(
		Effect.map(
			outcomeOf({ continues: "delegate-1", message: "Also update the docs.", group: "review" }),
			(outcome) => {
				expect(outcome).toEqual({
					isError: false,
					details: { ref: "delegate-1", kind: "delegate", next: "end your turn; delegate-1 wakes you" },
					continued: [{ ref: "delegate-1", message: "Also update the docs.", group: "review" }],
					started: [],
				});
			},
		),
	));

const refusedWith = (message: string) => ({
	isError: true,
	details: { error: "BadDelegate", message },
	continued: [],
	started: [],
});

const nameless = outcomeOf({ message: "m", role: "leaf", model: "quick", goal: "g" });

const messageless = outcomeOf({ name: "m", role: "leaf", model: "quick", goal: "g" });

test("a fresh call with no name or no message is a tool error that names the field, and starts nothing", () =>
	runtime.runPromise(
		Effect.map(Effect.all([nameless, messageless]), (outcomes) => {
			expect(outcomes).toEqual([
				refusedWith("name a `name`, which only a call with `continues` leaves out"),
				refusedWith("name a `message`, which only a call with `continues` leaves out"),
			]);
		}),
	));

test("a continuation that names a field of the brief it keeps is a tool error that names each, and continues nothing", () =>
	runtime.runPromise(
		Effect.map(
			outcomeOf({ continues: "delegate-1", name: "renamed", goal: "Other goal.", model: "deep" }),
			(outcome) => {
				expect(outcome).toEqual(
					refusedWith("a continuation keeps the brief it started with: leave out `name`, `goal`, `model`"),
				);
			},
		),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet())));
