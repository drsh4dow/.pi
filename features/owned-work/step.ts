import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { TerminalEnd, type TerminalAddress } from "../../clients/hc/index.ts";
import type { ChildSession, Role } from "./child.ts";
import {
	FailReason,
	type MonotonicNanos,
	type Handle,
	Outcome,
	type Settled,
	type Spawn,
	type StartRequest,
	Work,
	WorkEntry,
	type WorkKind,
	type WorkRef,
} from "./work.ts";

export interface LedgerState {
	readonly role: Role;
	readonly next: number;
	readonly work: ReadonlyMap<WorkRef, Work>;
	readonly phase: "running" | "idle";
	readonly now: MonotonicNanos;
}

export type Command = Data.TaggedEnum<{
	Kill: { readonly terminal: TerminalAddress };
	/** Show `terminal` under its group in Herdr's agents list. */
	ShowInGroup: { readonly terminal: TerminalAddress; readonly group: WorkRef; readonly name: string };
	StopSlice: { readonly ref: WorkRef };
	ReadAnswer: { readonly ref: WorkRef; readonly session: ChildSession; readonly end: TerminalEnd };
	ReadTail: { readonly ref: WorkRef; readonly terminal: TerminalAddress; readonly end: TerminalEnd };
	/** `after` counts from now, which a reload makes shorter than the watch's deadline. */
	ArmDeadline: { readonly ref: WorkRef; readonly after: Duration.Duration };
	Disarm: { readonly ref: WorkRef };
	Wake: { readonly results: ReadonlyArray<Settled> };
	Append: { readonly entry: WorkEntry };
	Unstage: { readonly session: ChildSession };
}>;

export const Command = Data.taggedEnum<Command>();

export type Verdict = Data.TaggedEnum<{
	Continue: { readonly results: ReadonlyArray<Settled> };
	Idle: { readonly outstanding: ReadonlyArray<WorkRef> };
	Finish: { readonly serves: ReadonlyArray<WorkRef> };
}>;

export const Verdict = Data.taggedEnum<Verdict>();

export interface Step<Reply> {
	readonly state: LedgerState;
	readonly commands: ReadonlyArray<Command>;
	readonly reply: Reply;
}

export type Woke = Step<ReadonlyArray<Settled>>;

export class UnknownRef extends Schema.TaggedError<UnknownRef, { readonly brand: unique symbol }>()("UnknownRef", {
	ref: Schema.String,
}) {}

export class NotYours extends Schema.TaggedError<NotYours, { readonly brand: unique symbol }>()("NotYours", {
	ref: Schema.String,
	why: Schema.String,
}) {}

export class NoJobs extends Schema.TaggedError<NoJobs, { readonly brand: unique symbol }>()("NoJobs", {
	refs: Schema.Array(Schema.String),
}) {}

export type LedgerError = UnknownRef | NotYours | NoJobs;

type Job = Exclude<Work, Data.TaggedEnum.Value<Work, "Serve">>;

type Group = Data.TaggedEnum.Value<Work, "Group">;

export interface Draft extends Omit<LedgerState, "work" | "next" | "phase"> {
	readonly work: Map<WorkRef, Work>;
	readonly commands: Array<Command>;
	next: number;
	phase: LedgerState["phase"];
}

const isServe = Work.$is("Serve");

const isGroup = Work.$is("Group");

const draftOf = (state: LedgerState): Draft => ({ ...state, work: new Map(state.work), commands: [] });

const kindOf = (work: Work | StartRequest): WorkKind => Str.uncapitalize(work._tag);

const spawnOf = (work: Work): Option.Option<Spawn> => (isGroup(work) ? Option.none() : work.spawn);

const terminalOf = (work: Work): Option.Option<TerminalAddress> =>
	Option.map(spawnOf(work), ({ terminal }) => terminal);

const handleOf = (work: Work): Handle => ({
	ref: work.ref,
	kind: kindOf(work),
	terminal: terminalOf(work),
	ready: Option.none(),
});

const isJob = (work: Work): work is Job => !isServe(work);

const jobs = (draft: Draft): Array<Job> => Arr.filter([...draft.work.values()], isJob);

const isLive = (work: Work): boolean => Option.isNone(work.settled);

const isUnconsumed = (work: Work): boolean => Option.exists(work.settled, (settlement) => !settlement.delivered);

const find = (draft: Draft, ref: WorkRef): Option.Option<Work> => Option.fromNullishOr(draft.work.get(ref));

const findAll = (draft: Draft, refs: ReadonlyArray<WorkRef>): Array<Work> =>
	Arr.getSomes(Arr.map(refs, (ref) => find(draft, ref)));

const job = (draft: Draft, ref: WorkRef): Option.Option<Job> => Option.filter(find(draft, ref), isJob);

const isDeliverable = (candidate: Work): boolean => isUnconsumed(candidate) && Option.isNone(candidate.heldBy);

const markDelivered = (draft: Draft, taken: ReadonlyArray<Work>): void => {
	for (const work of taken) {
		draft.work.set(work.ref, {
			...work,
			settled: Option.map(work.settled, (settlement) => ({ ...settlement, delivered: true })),
		});
	}
};

const resultsOf = (taken: ReadonlyArray<Work>): Array<Settled> =>
	Arr.flatMap([...Arr.filter(taken, isJob), ...Arr.filter(taken, isServe)], (work: Work) =>
		Option.toArray(Option.map(work.settled, ({ outcome }) => ({ ref: work.ref, kind: kindOf(work), outcome }))),
	);

const deliverable = (draft: Draft, within: (ref: WorkRef) => boolean): Array<Work> =>
	Arr.filter([...draft.work.values()], (candidate) => within(candidate.ref) && isDeliverable(candidate));

const hand = (draft: Draft, ready: ReadonlyArray<Work>): Array<Settled> => {
	markDelivered(draft, ready);

	return resultsOf(ready);
};

const takeWithJob = (draft: Draft): Array<Settled> => {
	const ready = deliverable(draft, () => true);

	return Arr.some(ready, isJob) ? hand(draft, ready) : [];
};

const wake = (draft: Draft): Array<Settled> => {
	const results = draft.phase === "idle" ? takeWithJob(draft) : [];

	if (Arr.isReadonlyArrayNonEmpty(results)) {
		draft.commands.push(Command.Wake({ results }));
		draft.phase = "running";
	}

	return results;
};

const stepOf = <Reply>({ commands, ...state }: Draft, reply: Reply): Step<Reply> => ({ state, commands, reply });

const finish = <Reply>(draft: Draft, reply: Reply): Step<Reply> => {
	wake(draft);

	return stepOf(draft, reply);
};

const woke = (draft: Draft): Woke => stepOf(draft, wake(draft));

const recordEnd = (draft: Draft, work: Work, outcome: Outcome, end: Option.Option<TerminalEnd>): void => {
	const durationMs = Number((draft.now - work.startedAt) / 1_000_000n);

	draft.commands.push(Command.Append({ entry: WorkEntry.JobSettled({ handle: work.ref, outcome, end, durationMs }) }));

	if (!isGroup(work)) {
		draft.commands.push(Command.StopSlice({ ref: work.ref }), Command.Disarm({ ref: work.ref }));
	}

	if (Work.$is("Delegate")(work)) {
		draft.commands.push(Command.Unstage({ session: work.childSession }));
	}
};

const holderOf = (draft: Draft, work: Work): Option.Option<Group> =>
	Option.flatMap(work.heldBy, (ref) => Option.filter(find(draft, ref), isGroup));

const groupAwaiting = (draft: Draft, work: Work): Option.Option<Group> =>
	isJob(work) ? holderOf(draft, work) : Option.none();

const settle = (draft: Draft, settling: Work, outcome: Outcome, end: Option.Option<TerminalEnd>): void => {
	if (!isLive(settling)) {
		return;
	}

	const holder = groupAwaiting(draft, settling);

	draft.work.set(settling.ref, { ...settling, settled: Option.some({ outcome, delivered: false }) });
	recordEnd(draft, settling, outcome, end);

	if (Option.isSome(holder)) {
		settleGroup(draft, holder.value);
	}
};

const halt = (draft: Draft, ref: WorkRef, reason: FailReason): void => {
	const live = Option.filter(find(draft, ref), isLive);

	for (const terminal of Option.toArray(Option.flatMap(live, terminalOf))) {
		draft.commands.push(Command.Kill({ terminal }));
	}

	if (Option.isSome(live)) {
		settle(draft, live.value, Outcome.Failed({ reason }), Option.none());
	}
};

const settleGroup = (draft: Draft, holder: Group): void => {
	const members = findAll(draft, holder.members);

	if (Arr.some(members, (member) => isJob(member) && isLive(member))) {
		return;
	}

	for (const serve of Arr.filter(members, isServe)) {
		halt(draft, serve.ref, FailReason.Cancelled({ group: Option.some(holder.ref) }));
	}

	const taken = Arr.filter(findAll(draft, holder.members), isUnconsumed);

	settle(draft, holder, Outcome.Members({ results: resultsOf(taken) }), Option.none());
	markDelivered(draft, taken);
};

const failure = (end: TerminalEnd): Outcome =>
	Outcome.Failed({
		reason: Match.valueTags(end, {
			Exited: ({ code, signal }) =>
				Option.isNone(code) && Option.contains(signal, 9)
					? FailReason.Oom({ signal: 9 })
					: FailReason.Exited({ code, signal }),
			Lost: ({ reason }) => FailReason.Lost({ why: reason }),
		}),
	});

const exitCode = (end: TerminalEnd): Option.Option<number> =>
	TerminalEnd.$is("Exited")(end) ? end.code : Option.none();

const isCleanExit = (end: TerminalEnd): boolean => Option.contains(exitCode(end), 0);

export const Draft = {
	of: draftOf,
	finish,
	woke,
	settle,
	settleGroup,
	holderOf,
	halt,
	find,
	findAll,
	job,
	jobs,
	takeWithJob,
	deliverable,
	hand,
	markDelivered,
	failure,
	exitCode,
	isCleanExit,
	isLive,
	isServe,
	isGroup,
	kindOf,
	handleOf,
	spawnOf,
	terminalOf,
};

export type { Group, Job };
