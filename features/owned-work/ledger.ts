import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { Hc, type HcError, type RunSpec } from "../../clients/hc/index.ts";
import { PiCli } from "../../clients/pi-cli/index.ts";
import { PiSessions } from "../../clients/pi-sessions/index.ts";
import { Slices } from "../../clients/systemd/index.ts";
import { launch, leafRole, type Role } from "./child.ts";
import { Command, type LedgerError, type LedgerState, type Step, type Verdict } from "./step.ts";
import { Transitions } from "./transitions.ts";
import {
	type GroupMode,
	type Handle,
	MonotonicNanos,
	monotonicNow,
	type Settled,
	StartRequest,
	type WorkEntry,
	type WorkRef,
} from "./work.ts";

export type SpawnError = HcError | PlatformError.PlatformError;

export type LedgerFailure = LedgerError | SpawnError;

export class Host extends Context.Service<
	Host,
	{
		readonly wake: (results: ReadonlyArray<Settled>) => Effect.Effect<void>;
		readonly append: (entry: WorkEntry) => Effect.Effect<void>;
	}
>()("pi-harness/features/owned-work/ledger/Host") {}

export class Ledger extends Context.Service<
	Ledger,
	{
		readonly start: (request: StartRequest) => Effect.Effect<Handle, SpawnError>;
		readonly group: (mode: GroupMode, refs: ReadonlyArray<WorkRef>) => Effect.Effect<Handle, LedgerError>;
		readonly stop: (refs: ReadonlyArray<WorkRef>) => Effect.Effect<ReadonlyArray<Settled>, LedgerError>;
		readonly runStarted: Effect.Effect<void>;
		readonly turnEnded: Effect.Effect<Verdict>;
		readonly wentIdle: Effect.Effect<void>;
	}
>()("pi-harness/features/owned-work/ledger") {}

export interface LedgerOptions {
	readonly role: Role;
	readonly agentKey: string;
	readonly cwd: string;
	readonly passEnv: Readonly<Record<string, string>>;
}

interface Kit {
	readonly options: LedgerOptions;
	readonly hc: (typeof Hc)["Service"];
	readonly host: (typeof Host)["Service"];
	readonly slices: (typeof Slices)["Service"];
	readonly sessions: (typeof PiSessions)["Service"];
	readonly cli: (typeof PiCli)["Service"];
	readonly state: Ref.Ref<LedgerState>;
	readonly lock: Semaphore.Semaphore;
	readonly fibers: FiberSet.FiberSet;
	readonly deadlines: FiberMap.FiberMap<WorkRef>;
}

const readyTimeout = Duration.seconds(60);

const tailLines = 40;

export const commandSpec =
	(options: LedgerOptions) =>
	(ref: WorkRef, command: string): RunSpec => ({
		ref,
		name: Str.slice(0, 32)(`${ref}-${options.agentKey}`),
		argv: ["choom", "-n", leafRole.nice, "--", "sh", "-c", command],
		cwd: options.cwd,
		env: { ...options.passEnv, ...leafRole.env },
	});

const specOf = ({ options, cli }: Kit, ref: WorkRef, request: StartRequest): Effect.Effect<RunSpec, SpawnError> =>
	Match.valueTags(request, {
		Delegate: ({ entry, message, childSession }) =>
			Effect.map(
				launch(cli)({ entry, message, ref, agentKey: options.agentKey, childSession, passEnv: options.passEnv }),
				(spawn) => ({ ref, cwd: childSession.cwd, ...spawn }),
			),
		Serve: ({ command }) => Effect.succeed(commandSpec(options)(ref, command)),
		Watch: ({ command }) => Effect.succeed(commandSpec(options)(ref, command)),
	});

const attempt = <Reply, Failure>(
	kit: Kit,
	transition: (current: LedgerState) => Result.Result<Step<Reply>, Failure>,
): Effect.Effect<Reply, Failure> =>
	Semaphore.withPermit(
		kit.lock,
		Effect.gen(function* () {
			const now = yield* monotonicNow;
			const current = yield* Ref.get(kit.state);
			const step = yield* Effect.fromResult(transition({ ...current, now }));

			yield* Ref.set(kit.state, step.state);
			yield* Effect.forEach(step.commands, (command) =>
				Command.$is("Append")(command) || Command.$is("ArmDeadline")(command)
					? run(kit, command)
					: runOutsideLock(kit, command),
			);

			return step.reply;
		}),
	);

const apply = <Reply>(kit: Kit, transition: (current: LedgerState) => Step<Reply>): Effect.Effect<Reply> =>
	attempt(kit, (current) => Result.succeed(transition(current)));

const run = (kit: Kit, command: Command): Effect.Effect<unknown> =>
	Match.valueTags(command, {
		Append: ({ entry }) => kit.host.append(entry),
		Kill: ({ terminal }) => kit.hc.kill(terminal),
		StopSlice: ({ ref }) => kit.slices.stop(ref),
		ReadAnswer: ({ ref, session, end }) =>
			Effect.flatMap(kit.sessions.readAnswer(session), (answer) =>
				apply(kit, (current) => Transitions.answered(current, ref, end, answer)),
			),
		ReadTail: ({ ref, terminal, end }) =>
			kit.hc.tail(terminal, tailLines).pipe(
				Effect.orElseSucceed(() => ""),
				Effect.flatMap((tail) => apply(kit, (current) => Transitions.watchEnded(current, ref, end, tail))),
			),
		ArmDeadline: ({ ref, after }) => {
			const passed = apply(kit, (current) => Transitions.deadlinePassed(current, ref, after));

			return FiberMap.run(kit.deadlines, ref, Effect.andThen(Effect.sleep(after), FiberSet.run(kit.fibers, passed)));
		},
		Disarm: ({ ref }) => FiberMap.remove(kit.deadlines, ref),
		Wake: ({ results }) => kit.host.wake(results),
		Unstage: ({ session }) => kit.cli.unstage(session),
	});

const runOutsideLock = (kit: Kit, command: Command): Effect.Effect<void> =>
	Effect.asVoid(FiberSet.run(kit.fibers, run(kit, command)));

const awaitReady = (kit: Kit, handle: Handle, request: StartRequest): Effect.Effect<Handle> => {
	const pattern = StartRequest.$is("Serve")(request) ? request.ready : Option.none<string>();

	return Option.match(Option.all({ pattern, terminal: handle.terminal }), {
		onNone: () => Effect.succeed(handle),
		onSome: ({ pattern: text, terminal }) =>
			kit.hc.waitForOutput(terminal, text, readyTimeout).pipe(
				Effect.orElseSucceed(() => false),
				Effect.map((matched) => ({ ...handle, ready: Option.some(matched) })),
			),
	});
};

const spawn = (kit: Kit, ref: WorkRef, request: StartRequest): Effect.Effect<Handle, SpawnError> =>
	Effect.flatMap(specOf(kit, ref, request), (spec) => kit.hc.run(kit.slices.wrap(spec))).pipe(
		Effect.matchEffect({
			onFailure: (error) =>
				Effect.flatMap(
					apply(kit, (current) => Transitions.spawnFailed(current, ref, error.message)),
					Option.match({ onNone: () => Effect.fail(error), onSome: Effect.succeed }),
				),
			onSuccess: (terminal) =>
				Effect.flatMap(
					apply(kit, (current) => Transitions.spawned(current, ref, terminal)),
					(handle) => awaitReady(kit, handle, request),
				),
		}),
	);

const start = (kit: Kit, request: StartRequest): Effect.Effect<Handle, SpawnError> =>
	Effect.gen(function* () {
		const ref = yield* apply(kit, (current) => Transitions.start(current, request));
		const detachedSpawn = yield* FiberSet.run(kit.fibers, spawn(kit, ref, request));

		return yield* Fiber.join(detachedSpawn);
	});

const follow = (kit: Kit): Effect.Effect<void> =>
	Stream.runForEach(kit.hc.notices, (notice) =>
		Match.valueTags(notice, {
			Ended: ({ terminal, end }) => apply(kit, (current) => Transitions.ended(current, terminal, end)),
			Resynced: ({ terminals, subscribedAt }) =>
				apply(kit, (current) => Transitions.resynced(current, terminals, MonotonicNanos(subscribedAt))),
		}),
	);

export const ledgerLayer = (
	options: LedgerOptions,
): Layer.Layer<Ledger, never, Hc | Host | Slices | PiSessions | PiCli> =>
	Layer.effect(
		Ledger,
		Effect.gen(function* () {
			const now = yield* monotonicNow;

			const kit: Kit = {
				options,
				hc: yield* Hc,
				host: yield* Host,
				slices: yield* Slices,
				sessions: yield* PiSessions,
				cli: yield* PiCli,
				state: yield* Ref.make(Transitions.initial(options.role, now)),
				lock: yield* Semaphore.make(1),
				fibers: yield* FiberSet.make(),
				deadlines: yield* FiberMap.make<WorkRef>(),
			};

			yield* Effect.forkScoped(follow(kit));

			return {
				start: (request) => start(kit, request),
				group: (mode, refs) => attempt(kit, (current) => Transitions.group(current, mode, refs)),
				stop: (refs) => attempt(kit, (current) => Transitions.stop(current, refs)),
				runStarted: Effect.asVoid(apply(kit, Transitions.runStarted)),
				turnEnded: apply(kit, Transitions.turnEnded),
				wentIdle: Effect.asVoid(apply(kit, Transitions.wentIdle)),
			};
		}),
	);
