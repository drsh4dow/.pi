import type { StopReason } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import type * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Str from "effect/String";

import { type HcNotice, TerminalEnd } from "../../clients/hc/index.ts";
import { piCliLayer } from "../../clients/pi-cli/index.ts";
import { piSessionsLayer } from "../../clients/pi-sessions/index.ts";
import { type ChildSession, type Role, Self } from "./child.ts";
import { Host, Ledger, ledgerLayer } from "./ledger.ts";
import { hcOf, slicesOf } from "./outside.fixture.ts";
import type { Verdict } from "./step.ts";
import { type FailReason, Outcome, type Settled, WorkEntry } from "./work.ts";

export type HeldSpawn = "succeeds" | "fails";

export interface World {
	readonly ledger: (typeof Ledger)["Service"];
	readonly notices: Queue.Queue<HcNotice>;
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
		Stopped: ({ by }) => `stopped by ${by}`,
	});

const show = ({ ref, outcome }: Pick<Settled, "ref" | "outcome">): string =>
	Match.valueTags(outcome, {
		Done: ({ text }) => `${ref} done: ${text}`,
		Fired: ({ exitCode, tail }) => `${ref} fired ${String(exitCode)}: ${tail}`,
		Members: ({ results }) => `${ref} [${Arr.join(Arr.map(results, show), ", ")}]`,
		Failed: ({ reason }) => `${ref} failed: ${reasonOf(reason)}`,
	});

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
				model: "claude-haiku-4-5",
				usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
				stopReason: index === texts.length - 1 ? lastStopReason : "stop",
				errorMessage: "429 rate limit",
				timestamp: 0,
			});
		}
	};

const hostOf = (world: Omit<World, "ledger" | "fs">) => {
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
					world.settles.push(show({ ref: entry.handle, outcome: entry.outcome }));
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

export const worldOf = (clock: World["clock"]) => (role: Role) =>
	Effect.gen(function* () {
		const notices = yield* Queue.unbounded<HcNotice>();
		const gate = yield* Semaphore.make(0);
		const scope = yield* Scope.make();

		const world: Omit<World, "ledger" | "fs"> = {
			notices,
			spawns: [],
			gate,
			pending: [],
			scope,
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
			clock,
			dead: false,
		};

		const fakes = Layer.mergeAll(hcOf(world), hostOf(world), slicesOf(world), piSessionsLayer, node);
		const self = role === "root" ? Self.Root({ role, level: 1 }) : Self.Delegate({ role, level: 2, slice: "pi-ow" });
		const ledger = ledgerLayer({ self, cwd: sessionRoot, passEnv: {} });
		const context = yield* Layer.buildWithScope(Layer.provideMerge(ledger, fakes), scope);

		return Object.assign(world, {
			ledger: Context.get(context, Ledger),
			fs: Context.get(context, FileSystem.FileSystem),
		});
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
