import { expect } from "bun:test";

import type { StopReason } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
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

import { HcNotice, TerminalAddress, type TerminalEnd } from "../../clients/hc/index.ts";
import type { Role } from "./child.ts";
import type { LedgerFailure } from "./ledger.ts";
import { Out } from "./out.ts";
import { type LedgerError, Verdict } from "./step.ts";
import { type Handle, MonotonicNanos, monotonicNow, type Settled, StartRequest, WorkRef } from "./work.ts";
import {
	deliveredRefs,
	leftovers,
	sessionRoot,
	showAll,
	showVerdict,
	steppable,
	type HeldSpawn,
	undelivered,
	type World,
	worldOf,
	writeAnswer,
} from "./world.fixture.ts";

export type Act = Data.TaggedEnum<{
	Hook: { readonly event: "run starts" | "goes idle" | "parent dies" | "pi reloads" };
	Start: {
		readonly kind: "delegate" | "serve" | "watch";
		readonly deadlineMs?: number;
		readonly messageKiB?: number;
		readonly instructionsKiB?: number;
		readonly heldThen?: HeldSpawn;
		readonly group?: string;
		readonly handle?: Readonly<Record<string, string | boolean>>;
	};
	Spawned: { readonly expect: string };
	Resync: { readonly askedMsAgo: number };
	Answer: {
		readonly terminal: string;
		readonly text: string;
		readonly closing?: string;
		readonly stopReason?: StopReason;
		readonly end: TerminalEnd;
	};
	End: { readonly terminal: string; readonly end: TerminalEnd };
	Group: { readonly refs: ReadonlyArray<string>; readonly expect: string };
	Cancel: { readonly refs: ReadonlyArray<string>; readonly expect: string };
	Running: { readonly expect: ReadonlyArray<string> };
	Waking: { readonly expect: ReadonlyArray<string> };
	TurnEnds: { readonly expect: string };
	Wakes: { readonly expect: ReadonlyArray<string> };
	Killed: { readonly expect: ReadonlyArray<string> };
	Settles: { readonly expect: ReadonlyArray<string> };
	Leftovers: { readonly expect: ReadonlyArray<string> };
	Slices: { readonly expect: ReadonlyArray<string> };
	SpawnLevels: { readonly expect: ReadonlyArray<string> };
	Shown: { readonly expect: ReadonlyArray<string> };
	Timers: { readonly expect: number };
	WallClockSteps: { readonly backMs: number };
	Pause: { readonly ms: number };
}>;

export const Act = Data.taggedEnum<Act>();

export interface Row {
	readonly name: string;
	readonly role: Role;
	readonly acts: ReadonlyArray<Act>;
}

const counter = { sessions: 0 };

const checked = <Value>(got: () => Value, expected: Value) =>
	Effect.sync(() => {
		expect(got()).toEqual(expected);
	});

const requestOf = (act: Data.TaggedEnum.Value<Act, "Start">): StartRequest => {
	counter.sessions += 1;

	const childSession = { id: `child-${String(counter.sessions)}`, cwd: sessionRoot, dir: `${sessionRoot}/delegates` };
	const deadline = Option.map(Option.fromUndefinedOr(act.deadlineMs), Duration.millis);
	const message = act.messageKiB === undefined ? "Review it." : Str.repeat(act.messageKiB * 1024)("x");
	const text = act.instructionsKiB === undefined ? "Review." : Str.repeat(act.instructionsKiB * 1024)("p");
	const instructions = Option.some({ file: "/r.md", text });
	const brief = { name: "Review it", message, model: "a/b", thinking: Option.none(), readOnly: false, instructions };

	return Match.value(act.kind).pipe(
		Match.when("delegate", () =>
			StartRequest.Delegate({ brief, childSession, group: Option.fromUndefinedOr(act.group) }),
		),
		Match.when("serve", () => StartRequest.Serve({ command: "serve", ready: Option.some("ready") })),
		Match.when("watch", () => StartRequest.Watch({ command: "watch", deadline })),
		Match.exhaustive,
	);
};

const refusal = (error: LedgerFailure): string => Out.error(error).message;

const handleChecked = (expected: Readonly<Record<string, string | boolean>> | undefined, handle: Handle): void => {
	if (expected !== undefined) {
		expect<object>(Out.handle(handle)).toEqual(expected);
	}
};

const start = (world: World, act: Data.TaggedEnum.Value<Act, "Start">) => {
	const request = requestOf(act);

	const started = (handle: Handle) => {
		const { ref, terminal, group } = handle;
		const address = Option.getOrElse(terminal, () => "");

		handleChecked(act.handle, handle);
		world.terminals.set(ref, address);

		if (StartRequest.$is("Delegate")(request)) {
			world.sessions.set(address, request.childSession);
		}

		world.owed.push(...Option.toArray(group));

		if (act.kind !== "serve") {
			world.owed.push(ref);
		}

		return ref;
	};

	if (act.heldThen === undefined) {
		return Effect.map(Effect.orDie(world.ledger.start(request)), started);
	}

	world.spawns.push(act.heldThen);

	const reply = Effect.match(world.ledger.start(request), { onFailure: refusal, onSuccess: started });

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

const replied = <Reply>(reply: Effect.Effect<Reply, LedgerError>, render: (value: Reply) => string, expected: string) =>
	Effect.flatMap(Effect.match(reply, { onFailure: refusal, onSuccess: render }), (got) =>
		checked(() => got, expected),
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

const refsAre = (refs: Effect.Effect<ReadonlyArray<string>>, expected: ReadonlyArray<string>) =>
	Effect.flatMap(refs, (got) => checked(() => got, expected));

const breather = Effect.sleep(Duration.millis(20));

const perform = (world: World, act: Act): Effect.Effect<void> =>
	Match.valueTags(act, {
		Hook: ({ event }) => hook(world, event),
		Start: (starting) => start(world, starting),
		Spawned: ({ expect: expected }) => spawnedNow(world, expected),
		Resync: ({ askedMsAgo }) => resync(world, askedMsAgo),
		Answer: (answering) => answer(world, answering),
		End: ({ terminal, end }) => ended(world, terminal, end),
		Group: (grouping) => group(world, grouping),
		Cancel: (cancelling) => cancel(world, cancelling),
		Running: ({ expect: expected }) => refsAre(world.ledger.running, expected),
		Waking: ({ expect: expected }) => refsAre(world.ledger.waking, expected),
		TurnEnds: ({ expect: expected }) => turnEnds(world, expected),
		Wakes: ({ expect: expected }) => checked(() => world.wakes.splice(0), [...expected]),
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
		Pause: ({ ms }) => Effect.sleep(Duration.millis(ms)),
	}).pipe(Effect.asVoid, Effect.andThen(breather));

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

export const runRow = (row: Row) => {
	const clock = { backMs: 0, sleeping: 0 };

	const play = Effect.gen(function* () {
		const world: World = yield* worldOf(clock)(row.role);

		yield* Effect.forEach(row.acts, (act) => perform(world, act), { discard: true });
		yield* Scope.close(world.scope, Exit.void);
		checkRules(world);
	});

	return Clock.clockWith((real) => Effect.provideService(play, Clock.Clock, steppable(clock)(real)));
};
