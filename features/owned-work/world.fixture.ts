import type { StopReason } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import type * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Str from "effect/String";

import { type Hc, type HcNotice, TerminalEnd } from "../../clients/hc/index.ts";
import { PiCli, piCliLayer } from "../../clients/pi-cli/index.ts";
import { piSessionsLayer } from "../../clients/pi-sessions/index.ts";
import type { Slices } from "../../clients/systemd/index.ts";
import { type ChildSession, type Role, Self } from "./child.ts";
import { Host, Ledger, ledgerLayer } from "./ledger.ts";
import { Out } from "./out.ts";
import { hcOf, slicesOf } from "./outside.fixture.ts";
import type { LedgerState, Verdict } from "./step.ts";
import { type FailReason, Outcome, type Settled, WorkEntry } from "./work.ts";

export type HeldSpawn = "succeeds" | "fails";

export interface World {
	ledger: (typeof Ledger)["Service"];
	/** Freezes this load's ledger and starts the next one from its state, as a pi reload does. */
	readonly reload: Effect.Effect<void>;
	readonly notices: Queue.Queue<HcNotice>;
	/** Like hc's subscription, which each load opens on its first run: closed until then, so notices wait. */
	readonly listening: Latch.Latch;
	readonly spawns: Array<HeldSpawn>;
	readonly gate: Semaphore.Semaphore;
	readonly pending: Array<Fiber.Fiber<string>>;
	readonly scope: Scope.Closeable;
	readonly sessions: Map<string, ChildSession>;
	readonly delivered: Array<Settled>;
	readonly owed: Array<string>;
	readonly groups: Map<string, ReadonlyArray<string>>;
	readonly terminals: Map<string, string>;
	readonly wakes: Array<string>;
	readonly kills: Array<string>;
	readonly gone: Set<string>;
	readonly slices: Set<string>;
	readonly spawnLevels: Array<string>;
	readonly shown: Array<string>;
	readonly hostCallsAfterDeath: Array<string>;
	readonly settles: Array<string>;
	readonly settledRefs: Array<string>;
	readonly fs: FileSystem.FileSystem;
	readonly clock: { backMs: number; sleeping: number };
	dead: boolean;
}

export const sessionRoot = `${Bun.env["TMPDIR"] ?? "/tmp"}/owned-work-test-${String(process.pid)}`;

const exited = (code: Option.Option<number>, signal: Option.Option<number>) => TerminalEnd.Exited({ code, signal });

export const exit = (code: number): TerminalEnd => exited(Option.some(code), Option.none());

export const killed = (signal: number): TerminalEnd => exited(Option.none(), Option.some(signal));

const reasonOf = (reason: FailReason): string =>
	Match.valueTags(reason, {
		Oom: () => "oom",
		Exited: () => "exited",
		Lost: () => "lost",
		Deadline: () => "deadline",
		SpawnFailed: () => "spawn failed",
		Errored: ({ why }) => `errored: ${why}`,
		Cancelled: (cancelled) => Out.reason(cancelled).detail,
	});

const show = ({ ref, outcome, log }: Pick<Settled, "ref" | "outcome" | "log">): string => {
	const logged = Option.match(log, { onNone: () => "", onSome: (path) => ` (log ${path})` });

	return Match.valueTags(outcome, {
		Done: ({ text }) => `${ref} done: ${text}`,
		Fired: ({ exitCode, tail }) => `${ref} fired ${String(exitCode)}${logged}: ${tail}`,
		Members: ({ results }) => `${ref} [${Arr.join(Arr.map(results, show), ", ")}]`,
		Failed: ({ reason }) => `${ref} failed: ${reasonOf(reason)}${logged}`,
	});
};

export const showAll = (results: ReadonlyArray<Settled>): string => Arr.join(Arr.map(results, show), "; ");

export const showVerdict = (verdict: Verdict): string =>
	Match.valueTags(verdict, {
		Continue: ({ results }) => `continue: ${showAll(results)}`,
		Idle: ({ outstanding }) => `idle: ${Arr.join(outstanding, ", ")}`,
		Finish: ({ serves }) => `finish: ${Arr.join(serves, ", ")}`,
	});

const flat = (settled: Settled): Array<Settled> =>
	Outcome.$is("Members")(settled.outcome) ? [settled, ...Arr.flatMap(settled.outcome.results, flat)] : [settled];

export const deliveredRefs = (world: World): Array<string> =>
	Arr.map(Arr.flatMap(world.delivered, flat), ({ ref }) => ref);

export const undelivered = (world: World): Array<string> => {
	const seen = deliveredRefs(world);

	return Arr.filter(world.owed, (ref) => !seen.includes(ref));
};

export const writeAnswer =
	(lastStopReason: StopReason) =>
	(texts: ReadonlyArray<string>) =>
	(session: ChildSession): void => {
		const manager = SessionManager.create(session.cwd, session.dir, { id: session.id });
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

		manager.appendMessage({ role: "user", content: "Review it.", timestamp: 0 });

		for (const [index, text] of texts.entries()) {
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
				stopReason: index === texts.length - 1 ? lastStopReason : "stop",
				errorMessage: "429 rate limit",
				timestamp: 0,
			});
		}
	};

const hostOf = (world: Omit<World, "ledger" | "fs" | "reload">) => {
	const record = (what: string, then: () => void) =>
		Effect.sync(() => {
			if (world.dead) {
				world.hostCallsAfterDeath.push(what);
			} else {
				then();
			}
		});

	const wake = (results: ReadonlyArray<Settled>) => () => {
		world.delivered.push(...results);
		world.wakes.push(showAll(results));
	};

	return Layer.succeed(Host, {
		wake: (results) => record("wake", wake(results)),
		append: (entry) =>
			record("append", () => {
				if (WorkEntry.$is("JobSettled")(entry)) {
					world.settles.push(show({ ref: entry.handle, outcome: entry.outcome, log: entry.log }));
					world.settledRefs.push(entry.handle);
				}
			}),
	});
};

export const node = Layer.provideMerge(piCliLayer(["/entrypoint.ts"]), NodeServices.layer);

export const steppable =
	(clock: World["clock"]) =>
	(real: Clock.Clock): Clock.Clock => {
		const millis = () => real.currentTimeMillisUnsafe() - clock.backMs;
		const nanos = () => real.currentTimeNanosUnsafe() - BigInt(clock.backMs) * 1_000_000n;

		const sleep = (duration: Duration.Duration) =>
			Effect.suspend(() => {
				clock.sleeping += 1;

				return Effect.ensuring(
					real.sleep(duration),
					Effect.sync(() => {
						clock.sleeping -= 1;
					}),
				);
			});

		return {
			currentTimeMillisUnsafe: millis,
			currentTimeMillis: Effect.sync(millis),
			currentTimeNanosUnsafe: nanos,
			currentTimeNanos: Effect.sync(nanos),
			monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
			monotonicTimeNanos: real.monotonicTimeNanos,
			sleep,
		};
	};

type Outside = Omit<World, "ledger" | "fs" | "reload">;

const blankWorld = (seed: Pick<Outside, "notices" | "listening" | "gate" | "scope" | "clock">): Outside => ({
	...seed,
	spawns: [],
	pending: [],
	sessions: new Map(),
	delivered: [],
	owed: [],
	groups: new Map(),
	terminals: new Map(),
	wakes: [],
	kills: [],
	gone: new Set(),
	slices: new Set(),
	spawnLevels: [],
	shown: [],
	hostCallsAfterDeath: [],
	settles: [],
	settledRefs: [],
	dead: false,
});

const selfOf = (role: Role) =>
	role === "root" ? Self.Root({ role, level: 1 }) : Self.Delegate({ role, level: 2, slice: "pi-ow" });

export const worldOf = (clock: World["clock"]) => (role: Role) =>
	Effect.gen(function* () {
		const notices = yield* Queue.unbounded<HcNotice>();
		const gate = yield* Semaphore.make(0);
		const scope = yield* Scope.make();

		const world = blankWorld({ notices, listening: yield* Latch.make(), gate, scope, clock });

		const outside = Layer.mergeAll(hcOf(world), hostOf(world), slicesOf(world), NodeServices.layer);
		const kept = yield* Layer.buildWithScope(outside, scope);
		const load = loadOf(selfOf(role), kept, scope);
		const loaded = { now: yield* load(Option.none()) };

		const full: World = Object.assign(world, {
			ledger: loaded.now.ledger,
			fs: Context.get(kept, FileSystem.FileSystem),
			reload: Effect.suspend(() =>
				Effect.map(reloaded(loaded.now, load, world.listening), (next) => {
					loaded.now = next;
					full.ledger = next.ledger;
				}),
			),
		});

		return full;
	});

const reloaded = (
	current: Load,
	load: (carried: Option.Option<LedgerState>) => Effect.Effect<Load>,
	listening: Latch.Latch,
) =>
	Effect.gen(function* () {
		const state = yield* current.ledger.freeze;

		yield* current.cli.release;
		yield* Scope.close(current.scope, Exit.void);
		yield* listening.close;

		return yield* load(Option.some(state));
	});

/** One load of the extension: what a reload rebuilds, while hc, systemd and the host outlive it. */
interface Load {
	readonly ledger: (typeof Ledger)["Service"];
	readonly cli: (typeof PiCli)["Service"];
	readonly scope: Scope.Closeable;
}

const loadOf =
	(self: Self, kept: Context.Context<Hc | Host | Slices | NodeServices.NodeServices>, scope: Scope.Scope) =>
	(carried: Option.Option<LedgerState>): Effect.Effect<Load> =>
		Effect.gen(function* () {
			const own = yield* Scope.fork(scope);
			const clients = Layer.mergeAll(piSessionsLayer, piCliLayer(["/entrypoint.ts"]));
			const ledger = ledgerLayer({ self, cwd: sessionRoot, passEnv: {}, firstRef: 1, carried });
			const layer = Layer.provide(Layer.provideMerge(ledger, clients), Layer.succeedContext(kept));
			const context = yield* Layer.buildWithScope(layer, own);

			return { ledger: Context.get(context, Ledger), cli: Context.get(context, PiCli), scope: own };
		});

export const leftovers = (world: World) =>
	Effect.gen(function* () {
		const names = yield* Effect.orElseSucceed(world.fs.readDirectory(`${sessionRoot}/delegates`), Arr.empty<string>);

		const left = Arr.flatMap([...world.sessions], ([terminal, { id }]) =>
			Arr.flatMap(names, (name) =>
				Str.startsWith(`${id}.`)(name) ? [`${terminal}${Str.slice(id.length)(name)}`] : [],
			),
		);

		return Arr.sort(left, Order.String);
	});
