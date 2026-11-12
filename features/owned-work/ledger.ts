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

import { Hc, type HcError, type RunSpec, terminalNameOf } from "../../clients/hc/index.ts";
import { PiCli } from "../../clients/pi-cli/index.ts";
import { PiSessions } from "../../clients/pi-sessions/index.ts";
import { Slices } from "../../clients/systemd/index.ts";
import { atLevel, launch, levels, type Self } from "./child.ts";
import { liveDelegates } from "./lifetime.ts";
import { Command, Draft, type LedgerError, type LedgerState, type Step, type Verdict } from "./step.ts";
import { Transitions } from "./transitions.ts";
import {
	type GroupRequest,
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
		readonly group: (request: GroupRequest) => Effect.Effect<Handle, LedgerError>;
		readonly cancel: (refs: ReadonlyArray<WorkRef>) => Effect.Effect<ReadonlyArray<Settled>, LedgerError>;
		readonly runStarted: Effect.Effect<void>;
		readonly turnEnded: Effect.Effect<Verdict>;
		readonly wentIdle: Effect.Effect<void>;
		readonly running: Effect.Effect<ReadonlyArray<WorkRef>>;
		readonly waking: Effect.Effect<ReadonlyArray<WorkRef>>;
		/** The state, for the next load of this extension after a reload. The ledger makes no more changes, so nothing it does after reaches the agent twice. */
		readonly freeze: Effect.Effect<LedgerState>;
	}
>()("pi-harness/features/owned-work/ledger") {}

export interface LedgerOptions {
	readonly self: Self;
	readonly cwd: string;
	readonly passEnv: Readonly<Record<string, string>>;
	/** The number of the first ref, past every ref the session's transcript names already. */
	readonly firstRef: number;
	/** The state a reload handed over, whose work keeps running. */
	readonly carried: Option.Option<LedgerState>;
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

/** A pi that a serve or watch starts is a leaf at the last level, so it cannot delegate. */
const commandChild = atLevel({ level: levels, role: "leaf" });

/** Herdr's agents mod reads these to pick each row's icon and the group it sits under. */
const labelOf = {
	kind: "ow.kind",
	group: "ow.group",
	groupName: "ow.group.name",
} as const;

/** Copies the command's output to the log at `$2`, and exits with the command's code rather than tee's. */
const teed = 'set -o pipefail; sh -c "$1" 2>&1 | tee -- "$2"';

const shellSpec =
	(options: Pick<LedgerOptions, "cwd" | "passEnv">) =>
	(ref: WorkRef, command: string, shell: ReadonlyArray<string>): Omit<RunSpec, "labels"> => ({
		ref,
		name: terminalNameOf(command),
		argv: ["choom", "-n", commandChild.oomScoreAdj, "--", "sh", ...shell],
		cwd: options.cwd,
		env: { ...options.passEnv, ...commandChild.env },
	});

export const commandSpec = (options: Pick<LedgerOptions, "cwd" | "passEnv">) => (ref: WorkRef, command: string) =>
	shellSpec(options)(ref, command, ["-c", command]);

export const watchSpec =
	(options: Pick<LedgerOptions, "cwd" | "passEnv">) => (ref: WorkRef, command: string, log: string) =>
		shellSpec(options)(ref, command, ["-c", teed, "sh", command, log]);

const specOf = ({ options, cli }: Kit, ref: WorkRef, request: StartRequest): Effect.Effect<RunSpec, SpawnError> => {
	const labels = { [labelOf.kind]: Draft.kindOf(request) };

	return Match.valueTags(request, {
		Delegate: ({ brief, childSession }) =>
			Effect.map(
				launch(cli)({ brief, level: options.self.level + 1, childSession, passEnv: options.passEnv }),
				(spawn) => ({ ref, cwd: childSession.cwd, labels, ...spawn }),
			),
		Serve: ({ command }) => Effect.succeed({ ...commandSpec(options)(ref, command), labels }),
		Watch: ({ command, log }) => Effect.succeed({ ...watchSpec(options)(ref, command, log), labels }),
	});
};

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
		ShowInGroup: ({ terminal, group, name }) =>
			kit.hc.label(terminal, { [labelOf.group]: group, [labelOf.groupName]: name }),
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
			const passed = apply(kit, (current) => Transitions.deadlinePassed(current, ref));

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
				state: yield* Ref.make(
					Option.getOrElse(options.carried, () => Transitions.initial(options.self.role, options.firstRef, now)),
				),
				lock: yield* Semaphore.make(1),
				fibers: yield* FiberSet.make(),
				deadlines: yield* FiberMap.make<WorkRef>(),
			};

			yield* Effect.forEach(Option.toArray(options.carried), (state) =>
				Effect.all([kit.hc.follow, kit.cli.adopt(liveDelegates(state)), apply(kit, Transitions.carried)]),
			);
			yield* Effect.forkScoped(follow(kit));

			return {
				start: (request) => start(kit, request),
				group: (request) => attempt(kit, (current) => Transitions.group(current, request)),
				cancel: (refs) => attempt(kit, (current) => Transitions.cancel(current, refs)),
				runStarted: Effect.asVoid(apply(kit, Transitions.runStarted)),
				turnEnded: apply(kit, Transitions.turnEnded),
				wentIdle: Effect.asVoid(apply(kit, Transitions.wentIdle)),
				running: Effect.map(Ref.get(kit.state), Transitions.running),
				waking: Effect.map(Ref.get(kit.state), Transitions.waking),
				freeze: Effect.andThen(Semaphore.take(kit.lock, 1), Ref.get(kit.state)),
			};
		}),
	);
