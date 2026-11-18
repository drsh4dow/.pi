import * as Context from "effect/Context";
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

import { Hc, type HcError, type RunSpec, terminalNameOf } from "#src/client/hc/index.ts";
import { PiCli } from "#src/client/pi-cli/index.ts";
import { PiSessions } from "#src/client/pi-sessions/index.ts";
import { Slices } from "#src/client/systemd/index.ts";
import { recordVerdict, type VerdictRecord, verdictsFolder } from "#src/features/pr/index.ts";
import { atLevel, launch, levels, type Self } from "./child.ts";
import { continuationOf } from "./continuation.ts";
import { type CommandRequest, framedArgv, serveReady, startTimeNow, watchTail } from "./frame.ts";
import { liveDelegates } from "./lifetime.ts";
import { Command, Draft, type LedgerState, type Step, type Verdict } from "./step.ts";
import { Transitions } from "./transitions.ts";
import {
	type ContinueRequest,
	type DelegateStart,
	type GroupRequest,
	type Handle,
	type LedgerError,
	MonotonicNanos,
	type NameTaken,
	type NotContinuable,
	monotonicNow,
	type Settled,
	StartRequest,
	type TimedRequest,
	type WorkEntry,
	type WorkRef,
} from "./work.ts";

type SpawnError = HcError | PlatformError.PlatformError;

export type StartError = SpawnError | NameTaken;

export type LedgerFailure = LedgerError | StartError | NotContinuable;

/** What recording a verdict needs, which the ledger takes when it is built and hands on. */
type VerdictServices = Effect.Services<ReturnType<ReturnType<typeof recordVerdict>>>;

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
		readonly start: (request: StartRequest) => Effect.Effect<Handle, StartError>;
		readonly continuation: (request: ContinueRequest) => Effect.Effect<DelegateStart, LedgerError | NotContinuable>;
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
	readonly verdictServices: Context.Context<VerdictServices>;
	readonly state: Ref.Ref<LedgerState>;
	readonly lock: Semaphore.Semaphore;
	readonly fibers: FiberSet.FiberSet;
	readonly deadlines: FiberMap.FiberMap<WorkRef>;
}

/** A pi that a serve or watch starts is a leaf at the last level, so it cannot delegate. */
const commandChild = atLevel({ level: levels, role: "leaf" });

/** Herdr's agents mod reads these to pick each row's icon and the group it sits under. */
const labelOf = {
	kind: "ow.kind",
	group: "ow.group",
	groupName: "ow.group.name",
} as const;

export const commandSpec =
	(options: Pick<LedgerOptions, "cwd" | "passEnv">) =>
	(ref: WorkRef, request: CommandRequest): Omit<RunSpec, "labels"> => ({
		ref,
		name: terminalNameOf(request.command),
		argv: ["choom", "-n", commandChild.oomScoreAdj, "--", "sh", ...framedArgv({ ref, cwd: options.cwd, request })],
		cwd: options.cwd,
		env: { ...options.passEnv, ...commandChild.env },
	});

const specOf = ({ options, cli }: Kit, ref: WorkRef, request: TimedRequest): Effect.Effect<RunSpec, SpawnError> => {
	const labels = { [labelOf.kind]: Draft.kindOf(request) };

	return Match.valueTags(request, {
		Delegate: ({ brief, childSession }) =>
			Effect.map(
				launch(cli)({ brief, level: options.self.level + 1, childSession, passEnv: options.passEnv }),
				(spawn) => ({ ref, cwd: childSession.cwd, labels, ...spawn }),
			),
		Serve: (serve) => Effect.succeed({ ...commandSpec(options)(ref, serve), labels }),
		Watch: (watch) => Effect.succeed({ ...commandSpec(options)(ref, watch), labels }),
	});
};

const recordOf = (kit: Kit, record: VerdictRecord) =>
	recordVerdict(verdictsFolder(kit.options.passEnv["HOME"] ?? ""))(record).pipe(
		Effect.provideContext(kit.verdictServices),
		Effect.catchCause((cause) => Effect.logWarning(`no verdict record at ${record.head}`, cause)),
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
		ReadTail: ({ watch, terminal, end }) =>
			watchTail({ hc: kit.hc, terminal, end, frame: { ref: watch.ref, cwd: kit.options.cwd, shown: watch } }).pipe(
				Effect.orElseSucceed(() => ""),
				Effect.flatMap((tail) => apply(kit, (current) => Transitions.watchEnded(current, watch.ref, end, tail))),
			),
		ArmDeadline: ({ ref, after }) => {
			const passed = apply(kit, (current) => Transitions.deadlinePassed(current, ref));

			return FiberMap.run(kit.deadlines, ref, Effect.andThen(Effect.sleep(after), FiberSet.run(kit.fibers, passed)));
		},
		Disarm: ({ ref }) => FiberMap.remove(kit.deadlines, ref),
		Wake: ({ results }) => kit.host.wake(results),
		Unstage: ({ session }) => kit.cli.unstage(session),
		RecordVerdict: ({ record }) => recordOf(kit, record),
	});

const runOutsideLock = (kit: Kit, command: Command): Effect.Effect<void> =>
	Effect.asVoid(FiberSet.run(kit.fibers, run(kit, command)));

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
				Command.$is("Append")(command) ||
				Command.$is("ArmDeadline")(command) ||
				Command.$is("RecordVerdict")(command)
					? run(kit, command)
					: runOutsideLock(kit, command),
			);

			return step.reply;
		}),
	);

const awaitReady = (kit: Kit, handle: Handle, request: TimedRequest): Effect.Effect<Handle> => {
	if (!StartRequest.$is("Serve")(request)) {
		return Effect.succeed(handle);
	}

	const frame = { ref: handle.ref, cwd: kit.options.cwd, shown: request };

	return Option.match(Option.all({ text: request.ready, terminal: handle.terminal }), {
		onNone: () => Effect.succeed(handle),
		onSome: ({ text, terminal }) =>
			serveReady({ hc: kit.hc, terminal, frame, text }).pipe(
				Effect.orElseSucceed(() => false),
				Effect.map((matched) => ({ ...handle, ready: Option.some(matched) })),
			),
	});
};

const spawn = (kit: Kit, ref: WorkRef, request: TimedRequest): Effect.Effect<Handle, SpawnError> =>
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

const start = (kit: Kit, asked: StartRequest): Effect.Effect<Handle, StartError> =>
	Effect.gen(function* () {
		const startTime = yield* startTimeNow;
		const request = { ...asked, startTime };
		const ref = yield* attempt(kit, (current) => Transitions.start(current, request));
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
): Layer.Layer<Ledger, never, Hc | Host | Slices | PiSessions | PiCli | VerdictServices> =>
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
				verdictServices: yield* Effect.context<VerdictServices>(),
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
				continuation: (request) =>
					Effect.flatMap(Ref.get(kit.state), (state) => Effect.fromResult(continuationOf(state)(request))),
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
