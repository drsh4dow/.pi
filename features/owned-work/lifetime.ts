import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import type { ChildSession } from "./child.ts";
import { Command, Draft, type LedgerState, type Woke } from "./step.ts";
import { type MonotonicNanos, Work, type WorkRef } from "./work.ts";

export const deadlineOf = (work: Work): Option.Option<Duration.Duration> =>
	Work.$is("Watch")(work) ? work.deadline : Option.none();

/** The live work the agent holds itself: what a session switch would stop. */
export const running = (state: LedgerState): ReadonlyArray<WorkRef> =>
	Arr.flatMap([...state.work.values()], (work) =>
		Draft.isLive(work) && Option.isNone(work.heldBy) ? [work.ref] : [],
	);

const rearmed =
	(now: MonotonicNanos) =>
	(work: Work): ReadonlyArray<Command> => {
		const spent = Duration.nanos(now - work.startedAt);
		const left = (deadline: Duration.Duration) => Duration.max(Duration.zero, Duration.subtract(deadline, spent));
		const deadline = Option.filter(deadlineOf(work), () => Draft.isLive(work));

		return Option.toArray(
			Option.map(deadline, (after) => Command.ArmDeadline({ ref: work.ref, after: left(after) })),
		);
	};

/**
 * A reload hands this ledger the state of the one before it, whose timers stopped with it. Each live watch's deadline
 * starts again for the time it has left, and any result that had not reached the agent wakes it.
 */
/** The sessions of the delegates still running, whose staged files the next load takes over. */
export const liveDelegates = (state: LedgerState): ReadonlyArray<ChildSession> =>
	Arr.flatMap([...state.work.values()], (work) =>
		Work.$is("Delegate")(work) && Draft.isLive(work) ? [work.childSession] : [],
	);

export const carried = (state: LedgerState): Woke => {
	const draft = Draft.of(state);

	draft.commands.push(...Arr.flatMap([...draft.work.values()], rearmed(state.now)));

	return Draft.woke(draft);
};
