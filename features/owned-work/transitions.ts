import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

import { TerminalEnd, type TerminalAddress, type TerminalSnapshot } from "../../clients/hc/index.ts";
import type { ChildReply } from "../../clients/pi-sessions/index.ts";
import type { Role } from "./child.ts";
import { Groups } from "./groups.ts";
import { Command, Draft, type Job, type LedgerState, type Step, type Woke, Verdict } from "./step.ts";
import {
	FailReason,
	type Handle,
	type MonotonicNanos,
	Outcome,
	type Spawn,
	type StartRequest,
	Work,
	WorkEntry,
	WorkRef,
} from "./work.ts";

const initial = (role: Role, now: MonotonicNanos): LedgerState => ({
	role,
	next: 1,
	work: new Map(),
	phase: "idle",
	now,
});

type Started = readonly [Work, WorkEntry, Option.Option<Duration.Duration>];

const startedOf = (request: StartRequest, ref: WorkRef, now: MonotonicNanos): Started => {
	const job = { ref, heldBy: Option.none(), startedAt: now, settled: Option.none(), spawn: Option.none() };

	return Match.valueTags(request, {
		Delegate: ({ entry, childSession }): Started => [
			Work.Delegate({ ...job, entry, childSession }),
			WorkEntry.DelegateStarted({
				handle: ref,
				delegate: entry.name,
				configFile: entry.file,
				configHash: entry.hash,
				model: entry.config.model,
				childSessionId: childSession.id,
			}),
			Option.map(Option.fromNullishOr(entry.config.deadline), Duration.seconds),
		],
		Watch: ({ command, deadline }): Started => [
			Work.Watch({ ...job, command, deadline }),
			WorkEntry.CommandStarted({ handle: ref, kind: "watch", command }),
			deadline,
		],
		Serve: ({ command }): Started => [
			Work.Serve({ ...job, command }),
			WorkEntry.CommandStarted({ handle: ref, kind: "serve", command }),
			Option.none(),
		],
	});
};

const start = (state: LedgerState, request: StartRequest): Step<WorkRef> => {
	const draft = Draft.of(state);
	const ref = WorkRef(`${Draft.kindOf(request)}-${String(state.next)}`);
	const [work, entry, deadline] = startedOf(request, ref, state.now);

	draft.next += 1;
	draft.work.set(ref, work);
	draft.commands.push(Command.Append({ entry }));

	if (Option.isSome(deadline)) {
		draft.commands.push(Command.ArmDeadline({ ref, after: deadline.value }));
	}

	return Draft.finish(draft, ref);
};

const spawned = (state: LedgerState, ref: WorkRef, terminal: TerminalAddress): Step<Handle> => {
	const draft = Draft.of(state);

	const work = {
		...Option.getOrThrow(Draft.find(draft, ref)),
		spawn: Option.some({ terminal, learnedAt: state.now }),
	};

	draft.work.set(ref, work);

	if (!Draft.isLive(work)) {
		draft.commands.push(Command.Kill({ terminal }), Command.StopSlice({ ref }));
	}

	return Draft.finish(draft, Draft.handleOf(work));
};

const spawnFailed = (state: LedgerState, ref: WorkRef, why: string): Step<Option.Option<Handle>> => {
	const draft = Draft.of(state);
	const job = Draft.job(draft, ref);

	Draft.halt(draft, ref, FailReason.SpawnFailed({ why }));

	const reportedByItsStartCall = Arr.filter(Draft.findAll(draft, [ref]), Draft.isServe);

	Draft.markDelivered(draft, reportedByItsStartCall);

	return Draft.finish(draft, Option.map(job, Draft.handleOf));
};

const endWork = (draft: Draft, work: Work, end: TerminalEnd): void => {
	const command = Match.valueTags(work, {
		Delegate: (delegate) =>
			Option.liftPredicate(Command.ReadAnswer({ ref: delegate.ref, session: delegate.childSession, end }), () =>
				Draft.isLive(delegate),
			),
		Watch: (watch) =>
			Option.map(
				Option.filter(watch.spawn, () => Draft.isLive(watch)),
				({ terminal }) => Command.ReadTail({ ref: watch.ref, terminal, end }),
			),
		Serve: (serve) => {
			Draft.settle(draft, serve, Draft.failure(end), Option.some(end));

			return Option.none<Command>();
		},
		Group: () => Option.none<Command>(),
	});

	draft.commands.push(...Option.toArray(command));
};

const ended = (state: LedgerState, terminal: TerminalAddress, end: TerminalEnd): Woke => {
	const draft = Draft.of(state);

	const work = Arr.findFirst(draft.work.values(), (candidate) =>
		Option.contains(Draft.terminalOf(candidate), terminal),
	);

	if (Option.isSome(work)) {
		endWork(draft, work.value, end);
	}

	return Draft.woke(draft);
};

const settleJob = (state: LedgerState, ref: WorkRef, outcome: Outcome, end: Option.Option<TerminalEnd>): Woke => {
	const draft = Draft.of(state);
	const job = Draft.job(draft, ref);

	if (Option.isSome(job)) {
		Draft.settle(draft, job.value, outcome, end);
	}

	return Draft.woke(draft);
};

/**
 * Done(answer) needs both an answer and a clean exit, because `ctx.shutdown()` exits 0: a child killed mid-run or
 * while idle on a watcher has an assistant text that is not its answer. A provider error is the reason only when the
 * child exited with a code, since a kill or a lost terminal ended it first.
 */
const answered = (state: LedgerState, ref: WorkRef, end: TerminalEnd, reply: Option.Option<ChildReply>): Woke => {
	const outcome = Option.match(reply, {
		onNone: () => Draft.failure(end),
		onSome: Match.valueTags({
			Answered: ({ text }) => (Draft.isCleanExit(end) ? Outcome.Done({ text }) : Draft.failure(end)),
			Errored: ({ why }) =>
				Option.isSome(Draft.exitCode(end))
					? Outcome.Failed({ reason: FailReason.Errored({ why }) })
					: Draft.failure(end),
		}),
	});

	return settleJob(state, ref, outcome, Option.some(end));
};

const watchEnded = (state: LedgerState, ref: WorkRef, end: TerminalEnd, tail: string): Woke => {
	const outcome = Option.match(Draft.exitCode(end), {
		onNone: () => Draft.failure(end),
		onSome: (exitCode) => Outcome.Fired({ exitCode, tail }),
	});

	return settleJob(state, ref, outcome, Option.some(end));
};

const deadlinePassed = (state: LedgerState, ref: WorkRef, after: Duration.Duration): Woke => {
	const draft = Draft.of(state);

	Draft.halt(draft, ref, FailReason.Deadline({ after }));

	return Draft.woke(draft);
};

const runStarted = (state: LedgerState): Woke => {
	const draft = Draft.of(state);

	draft.phase = "running";

	return Draft.woke(draft);
};

const turnEnded = (state: LedgerState): Step<Verdict> => {
	const draft = Draft.of(state);
	const results = Draft.takeWithJob(draft);
	const outstanding = Arr.map(Arr.filter(Draft.jobs(draft), Draft.isLive), (job: Job) => job.ref);

	const serves = Arr.flatMap([...draft.work.values()], (work) =>
		Draft.isServe(work) && Draft.isLive(work) ? [work.ref] : [],
	);

	if (Arr.isReadonlyArrayNonEmpty(results)) {
		return Draft.finish(draft, Verdict.Continue({ results }));
	}

	const idle = Arr.isReadonlyArrayNonEmpty(outstanding) || state.role === "root";

	return Draft.finish(draft, idle ? Verdict.Idle({ outstanding }) : Verdict.Finish({ serves }));
};

const wentIdle = (state: LedgerState): Woke => {
	const draft = Draft.of(state);

	draft.phase = "idle";

	return Draft.woke(draft);
};

const learnedBefore =
	(subscribedAt: MonotonicNanos) =>
	({ learnedAt }: Spawn): boolean =>
		learnedAt < subscribedAt;

const resynced = (
	state: LedgerState,
	terminals: ReadonlyArray<TerminalSnapshot>,
	subscribedAt: MonotonicNanos,
): Woke => {
	const draft = Draft.of(state);
	const lost = TerminalEnd.Lost({ reason: "missing after an hc resync" });

	for (const work of draft.work.values()) {
		const spawn = Option.filter(Draft.spawnOf(work), () => Draft.isLive(work));

		const snapshot = Option.flatMap(spawn, ({ terminal }) =>
			Arr.findFirst(terminals, (seen) => seen.terminal === terminal),
		);

		const missing = Option.filter(spawn, learnedBefore(subscribedAt));
		const end = Option.isSome(snapshot) ? snapshot.value.end : Option.as(missing, lost);

		if (Option.isSome(end)) {
			endWork(draft, work, end.value);
		}
	}

	return Draft.woke(draft);
};

export const Transitions = {
	initial,
	start,
	spawned,
	spawnFailed,
	ended,
	answered,
	watchEnded,
	deadlinePassed,
	group: Groups.group,
	stop: Groups.stop,
	runStarted,
	turnEnded,
	wentIdle,
	resynced,
};
