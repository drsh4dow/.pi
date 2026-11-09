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
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { Hc, HcError, HcNotice, type RunSpec, TerminalAddress, TerminalEnd } from "../../clients/hc/index.ts";
import { piCliLayer } from "../../clients/pi-cli/index.ts";
import { piSessionsLayer } from "../../clients/pi-sessions/index.ts";
import { Slices } from "../../clients/systemd/index.ts";
import { type ChildSession, type Role, Self } from "./child.ts";
import { Host, Ledger, ledgerLayer } from "./ledger.ts";
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

const hangUp = (terminal: TerminalAddress) => HcNotice.Ended({ terminal, end: killed(1) });

/** Linux MAX_ARG_STRLEN, which counts the closing NUL: execve fails with E2BIG on a longer argv word. */
const argvWordLimit = 128 * 1024;

const tooLong = (spec: RunSpec) => Arr.some(spec.argv, (word) => Buffer.byteLength(word) >= argvWordLimit);

const failed = (why: string) => HcError.make({ method: "terminal.run", kind: "spawn_failed", message: why });

const hcOf = (world: Omit<World, "ledger" | "fs">) => {
	const spawned = { count: 0 };

	const recorded = (terminal: TerminalAddress) => () => {
		world.kills.push(terminal);
		world.gone.add(terminal);
	};

	const kill = (terminal: TerminalAddress) =>
		Effect.andThen(Effect.sync(recorded(terminal)), Queue.offer(world.notices, hangUp(terminal)));

	const run = Effect.fn("run")(function* (spec: RunSpec) {
		const held = world.spawns.shift();

		if (held !== undefined) {
			yield* Semaphore.take(world.gate, 1);
		}

		if (tooLong(spec)) {
			return yield* failed("E2BIG");
		}

		if (held === "fails") {
			return yield* failed("no such program");
		}

		world.slices.add(spec.ref);

		return TerminalAddress(`t${String((spawned.count += 1))}`);
	});

	return Layer.succeed(Hc, {
		run,
		kill,
		waitForOutput: () => Effect.succeed(true),
		tail: () => Effect.succeed("tail"),
		notices: Stream.fromQueue(world.notices),
	});
};

const slicesOf = (world: Omit<World, "ledger" | "fs">) =>
	Layer.succeed(Slices, {
		wrap: (spec) => spec,
		stop: (ref) =>
			Effect.sync(() => {
				world.slices.delete(ref);
			}),
	});

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
			hostCallsAfterDeath: [],
			settles: [],
			settledRefs: [],
			clock,
			dead: false,
		};

		const fakes = Layer.mergeAll(hcOf(world), hostOf(world), slicesOf(world), piSessionsLayer, node);
		const self = role === "root" ? Self.Root({ role, level: 1 }) : Self.Delegate({ role, level: 2, slice: "pi-ow" });
		const ledger = ledgerLayer({ self, agentKey: "test", cwd: sessionRoot, passEnv: {} });
		const context = yield* Layer.buildWithScope(Layer.provideMerge(ledger, fakes), scope);

		return Object.assign(world, {
			ledger: Context.get(context, Ledger),
			fs: Context.get(context, FileSystem.FileSystem),
		});
	});
