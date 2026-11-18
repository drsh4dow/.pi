import { expect } from "bun:test";

import * as Arr from "effect/Array";
import type * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Str from "effect/String";

import { HcNotice, TerminalAddress, type TerminalEnd } from "#src/client/hc/index.ts";
import { type Act, recordsAre, type Row } from "./act.fixture.ts";
import type { LedgerFailure } from "./ledger.ts";
import { Out } from "./out.ts";
import { printed } from "./outside.fixture.ts";
import { drained, settling } from "./settle.fixture.ts";
import { Verdict } from "./step.ts";
import { type Handle, MonotonicNanos, monotonicNow, Outcome, type Settled, StartRequest, WorkRef } from "./work.ts";
import {
	deliveredRefs,
	leftovers,
	sessionRoot,
	showAll,
	showVerdict,
	undelivered,
	type World,
	worldOf,
	writeAnswer,
} from "./world.fixture.ts";

export { Act, type Row } from "./act.fixture.ts";

const counter = { sessions: 0 };

const checked = <Value>(got: () => Value, expected: Value) =>
	Effect.sync(() => {
		expect(got()).toEqual(expected);
	});

const briefOf = (world: World, act: Data.TaggedEnum.Value<Act, "Start">) => {
	world.delegatesStarted += 1;

	const name = act.name ?? `Review ${String(world.delegatesStarted)}`;
	const message = act.messageKiB === undefined ? "Review it." : Str.repeat(act.messageKiB * 1024)("x");
	const text = act.instructionsKiB === undefined ? "Review." : Str.repeat(act.instructionsKiB * 1024)("p");
	const fixed = { name, role: "leaf", model: "a/b", goal: "Cap the retries.", readOnly: false } as const;
	const unset = { thinking: Option.none(), state: Option.none(), facts: Option.none() };

	return { ...fixed, ...unset, ...act.verifies, message, instructions: Option.some({ file: "/r.md", text }) };
};

const requestOf = (world: World, act: Data.TaggedEnum.Value<Act, "Start">): StartRequest => {
	counter.sessions += 1;

	const childSession = { id: `child-${String(counter.sessions)}`, cwd: sessionRoot, dir: `${sessionRoot}/delegates` };
	const deadline = Option.map(Option.fromUndefinedOr(act.deadlineMs), Duration.millis);
	const group = Option.fromUndefinedOr(act.group);

	return Match.value(act.kind).pipe(
		Match.when("delegate", () => StartRequest.Delegate({ brief: briefOf(world, act), childSession, group })),
		Match.when("serve", () => StartRequest.Serve({ command: "serve", ready: Option.some(printed) })),
		Match.when("watch", () => StartRequest.Watch({ command: "watch", deadline, log: "watch.log" })),
		Match.exhaustive,
	);
};

const refusal = (error: LedgerFailure): string => Out.error(error).message;

const handleChecked = (expected: Readonly<Record<string, string | boolean>> | undefined, handle: Handle): void => {
	if (expected !== undefined) {
		expect<object>(Out.handle(handle)).toEqual(expected);
	}
};

const replyOf = (world: World, act: Data.TaggedEnum.Value<Act, "Start">) =>
	act.continues === undefined
		? world.ledger.start(requestOf(world, act))
		: Effect.flatMap(
				world.ledger.continuation({
					ref: WorkRef(act.continues),
					message: Option.fromUndefinedOr(act.message),
					group: Option.none(),
				}),
				world.ledger.start,
			);

const replied = <Reply>(
	reply: Effect.Effect<Reply, LedgerFailure>,
	render: (value: Reply) => string,
	expected: string,
) =>
	Effect.flatMap(Effect.match(reply, { onFailure: refusal, onSuccess: render }), (got) =>
		checked(() => got, expected),
	);

const start = (world: World, act: Data.TaggedEnum.Value<Act, "Start">) => {
	const request = replyOf(world, act);

	const started = (handle: Handle) => {
		const { ref, terminal, group } = handle;
		const address = Option.getOrElse(terminal, () => "");

		handleChecked(act.handle, handle);
		world.terminals.set(ref, address);
		world.owed.push(...Option.toArray(group));

		if (act.kind !== "serve") {
			world.owed.push(ref);
		}

		return ref;
	};

	if (act.refused !== undefined) {
		return replied(request, ({ ref }) => `started ${ref}`, act.refused);
	}

	if (act.heldThen === undefined) {
		return Effect.map(Effect.orDie(request), started);
	}

	world.spawns.push(act.heldThen);

	const reply = Effect.match(request, { onFailure: refusal, onSuccess: started });

	return Effect.map(Effect.forkIn(reply, world.scope), (fiber) => world.pending.push(fiber));
};

const spawnedNow = (world: World, expected: string) =>
	Effect.andThen(
		Semaphore.release(world.gate, 1),
		Effect.fromNullishOr(world.pending.shift()).pipe(
			Effect.flatMap(Fiber.join),
			Effect.orDie,
			Effect.flatMap((got) => checked(() => got, expected)),
		),
	);

const resync = (world: World, askedMsAgo: number) =>
	Effect.flatMap(monotonicNow, (now) => {
		const subscribedAt = MonotonicNanos(now - BigInt(askedMsAgo) * 1_000_000n);

		return Queue.offer(world.notices, HcNotice.Resynced({ terminals: [], subscribedAt }));
	});

const ended = (world: World, terminal: string, end: TerminalEnd) =>
	Queue.offer(world.notices, HcNotice.Ended({ terminal: TerminalAddress(terminal), end })).pipe(
		Effect.tap(Effect.sync(() => world.gone.add(terminal))),
	);

const answer = (world: World, { terminal, text, closing, stopReason, end }: Data.TaggedEnum.Value<Act, "Answer">) =>
	Effect.andThen(
		Effect.sync(() =>
			Option.map(
				Option.fromUndefinedOr(world.sessions.get(terminal)),
				writeAnswer(stopReason ?? "stop")(closing === undefined ? [text] : [text, closing]),
			),
		),
		ended(world, terminal, end),
	);

const group = (world: World, act: Data.TaggedEnum.Value<Act, "Group">) => {
	const adopted = ({ ref }: Handle) => {
		world.groups.set(ref, act.refs);
		world.owed.push(ref);

		return ref;
	};

	const request = { name: "principles eval", members: Arr.map(act.refs, WorkRef) };

	return replied(world.ledger.group(request), adopted, act.expect);
};

const cancel = (world: World, act: Data.TaggedEnum.Value<Act, "Cancel">) => {
	const handed = (results: ReadonlyArray<Settled>) => {
		world.delivered.push(...results);

		return showAll(results);
	};

	return replied(world.ledger.cancel(Arr.map(act.refs, WorkRef)), handed, act.expect);
};

const turnEnds = (world: World, expected: string) =>
	Effect.flatMap(world.ledger.turnEnded, (verdict) => {
		if (Verdict.$is("Continue")(verdict)) {
			world.delivered.push(...verdict.results);
		}

		const abandoned = Verdict.$is("Finish")(verdict) ? undelivered(world) : [];

		return checked(() => [showVerdict(verdict), ...abandoned], [expected]);
	});

const hook = (world: World, event: Data.TaggedEnum.Value<Act, "Hook">["event"]): Effect.Effect<void> =>
	Match.value(event).pipe(
		Match.when("run starts", () => world.ledger.runStarted),
		Match.when("goes idle", () => world.ledger.wentIdle),
		Match.when("pi reloads", () => world.reload),
		Match.when("parent dies", () =>
			Effect.andThen(
				Scope.close(world.scope, Exit.void),
				Effect.sync(() => {
					world.dead = true;
				}),
			),
		),
		Match.exhaustive,
	);

const sessionOf = (world: World) => (terminal: string) =>
	world.sessions.get(terminal)?.id ?? `no session in ${terminal}`;

const answerFiles = (world: World) =>
	Effect.forEach(
		Arr.flatMap(world.delivered, ({ outcome }) => (Outcome.$is("Done")(outcome) ? [outcome.answer.file] : [])),
		(file) => world.fs.readFileString(file),
	);

const staged = (world: World, terminal: string) => {
	const { id, dir } = world.sessions.get(terminal) ?? { id: "none", dir: "none" };
	const read = (suffix: string) => world.fs.readFileString(`${dir}/${id}.${suffix}`);

	return Effect.map(Effect.all([read("brief.json"), read("message")]), ([brief, message]) => ({
		session: id,
		brief,
		message,
	}));
};

const perform = (world: World, act: Act): Effect.Effect<void> =>
	Match.valueTags(act, {
		Hook: ({ event }) => hook(world, event),
		Start: (starting) => start(world, starting),
		Launched: ({ terminal, expect: expected }) =>
			Effect.flatMap(Effect.orDie(staged(world, terminal)), (got) => checked(() => got, expected(sessionOf(world)))),
		Spawned: ({ expect: expected }) => spawnedNow(world, expected),
		Resync: ({ askedMsAgo }) => resync(world, askedMsAgo),
		Answer: (answering) => answer(world, answering),
		End: ({ terminal, end }) => ended(world, terminal, end),
		Group: (grouping) => group(world, grouping),
		Cancel: (cancelling) => cancel(world, cancelling),
		Running: ({ expect: expected }) => Effect.flatMap(world.ledger.running, (got) => checked(() => got, expected)),
		Waking: ({ expect: expected }) => Effect.flatMap(world.ledger.waking, (got) => checked(() => got, expected)),
		TurnEnds: ({ expect: expected }) => turnEnds(world, expected),
		Wakes: ({ expect: expected }) => checked(() => world.wakes.splice(0), [...expected]),
		Delivered: ({ expect: expected }) =>
			checked(() => Arr.map(world.delivered, Out.result), [...expected(sessionOf(world))]),
		AnswerFiles: ({ expect: expected }) =>
			Effect.flatMap(Effect.orDie(answerFiles(world)), (texts) => checked(() => texts, [...expected])),
		VerdictRecords: ({ pr, expect: expected }) => recordsAre(world.fs)({ pr, expected: expected(sessionOf(world)) }),
		Killed: ({ expect: expected }) => checked(() => world.kills.splice(0), [...expected]),
		Settles: ({ expect: expected }) => checked(() => world.settles.splice(0), [...expected]),
		Leftovers: ({ expect: expected }) =>
			Effect.flatMap(leftovers(world), (left) => checked(() => left, [...expected])),
		Slices: ({ expect: expected }) => checked(() => Arr.sort([...world.slices], Order.String), [...expected]),
		SpawnLevels: ({ expect: expected }) => checked(() => world.spawnLevels, [...expected]),
		Shown: ({ expect: expected }) => checked(() => world.shown.splice(0), [...expected]),
		Timers: ({ expect: expected }) => checked(() => world.clock.sleeping, expected),
		WallClockSteps: ({ backMs }) =>
			Effect.sync(() => {
				world.clock.backMs += backMs;
			}),
		Pause: ({ ms }) => world.clock.paused.adjust(Duration.millis(ms)),
	}).pipe(Effect.asVoid, Effect.andThen(drained(world.inFlight)));

const checkRules = (world: World): void => {
	const refs = deliveredRefs(world);
	const groupResults = Arr.filter(refs, (ref) => world.groups.has(ref));
	const servesOf = (ref: string) => Arr.filter(world.groups.get(ref) ?? [], Str.startsWith("serve-"));
	const running = (serve: string) => !world.gone.has(world.terminals.get(serve) ?? "");

	expect(Arr.filter(refs, (ref, index) => refs.indexOf(ref) !== index)).toEqual([]);
	expect(world.dead ? world.hostCallsAfterDeath : undelivered(world)).toEqual([]);
	expect(Arr.filter(Arr.flatMap(groupResults, servesOf), running)).toEqual([]);
	expect(Arr.filter(world.settledRefs, (ref) => world.slices.has(ref))).toEqual([]);
};

export const runRow = (row: Row) =>
	settling((pacing) =>
		Effect.gen(function* () {
			const world: World = yield* worldOf(pacing)(row.role);

			yield* Effect.forEach(row.acts, (act) => perform(world, act), { discard: true });
			yield* Scope.close(world.scope, Exit.void);
			checkRules(world);
		}),
	);
