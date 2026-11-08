import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
	Command,
	Draft,
	type LedgerError,
	type LedgerState,
	NoJobs,
	NotYours,
	type Step,
	type Woke,
	UnknownRef,
} from "./step.ts";
import { FailReason, type GroupMode, type Handle, Work, WorkEntry, WorkRef } from "./work.ts";

const eachSettled =
	"it is an each group that already settled: its members' results reach you one by one, and it has none of its own";

const refused = (draft: Draft, ref: WorkRef): Option.Option<LedgerError> => {
	const work = draft.work.get(ref);

	if (work === undefined) {
		return Option.some(UnknownRef.make({ ref }));
	}

	if (Option.isSome(work.heldBy)) {
		return Option.some(NotYours.make({ ref, why: `${work.heldBy.value} holds it` }));
	}

	const delivered = Option.filter(Draft.job(draft, ref), (job) =>
		Option.exists(job.settled, (settlement) => settlement.delivered),
	);

	const why = Draft.passesThrough(work) ? eachSettled : "its result was already delivered";

	return Option.as(delivered, NotYours.make({ ref, why }));
};

const sameGroup = (work: Work, mode: GroupMode, members: ReadonlyArray<WorkRef>): boolean =>
	Work.$is("Group")(work) &&
	work.mode === mode &&
	work.members.length === members.length &&
	Arr.every(members, (ref) => work.members.includes(ref));

const rejected = (draft: Draft, members: ReadonlyArray<WorkRef>): Option.Option<LedgerError> => {
	const problem = Arr.findFirst(members, (ref) => refused(draft, ref));
	const hasJob = Arr.some(members, (ref) => Option.isSome(Draft.job(draft, ref)));

	return Option.isSome(problem) || hasJob ? problem : Option.some(NoJobs.make({ refs: members }));
};

const adopt = (draft: Draft, mode: GroupMode, members: ReadonlyArray<WorkRef>): Work => {
	const ref = WorkRef(`group-${String(draft.next)}`);

	const created = Work.Group({
		ref,
		heldBy: Option.none(),
		startedAt: draft.now,
		settled: Option.none(),
		mode,
		members,
	});

	draft.next += 1;
	draft.work.set(ref, created);

	for (const member of Draft.findAll(draft, members)) {
		draft.work.set(member.ref, { ...member, heldBy: Option.some(ref) });
	}

	draft.commands.push(Command.Append({ entry: WorkEntry.GroupStarted({ handle: ref, mode, members }) }));
	Draft.settleGroup(draft, created);

	return created;
};

const group = (
	state: LedgerState,
	mode: GroupMode,
	refs: ReadonlyArray<WorkRef>,
): Result.Result<Step<Handle>, LedgerError> => {
	const draft = Draft.of(state);
	const members = Arr.dedupe(refs);
	const same = Arr.findFirst(draft.work.values(), (work) => sameGroup(work, mode, members));
	const problem = Option.isSome(same) ? Option.none() : rejected(draft, members);

	if (Option.isSome(problem)) {
		return Result.fail(problem.value);
	}

	const created = Option.getOrElse(same, () => adopt(draft, mode, members));

	return Result.succeed(Draft.finish(draft, Draft.handleOf(created)));
};

const closure = (draft: Draft, refs: ReadonlyArray<WorkRef>): Map<WorkRef, WorkRef> => {
	const found = new Map<WorkRef, WorkRef>();

	const visit = (ref: WorkRef, by: WorkRef): void => {
		const work = draft.work.get(ref);

		if (work !== undefined && !found.has(ref)) {
			found.set(ref, by);

			for (const member of Work.$is("Group")(work) ? work.members : []) {
				visit(member, by);
			}
		}
	};

	for (const ref of refs) {
		visit(ref, ref);
	}

	return found;
};

const stop = (state: LedgerState, refs: ReadonlyArray<WorkRef>): Result.Result<Woke, UnknownRef> => {
	const draft = Draft.of(state);
	const unknown = Arr.findFirst(refs, (ref) => !draft.work.has(ref));

	if (Option.isSome(unknown)) {
		return Result.fail(UnknownRef.make({ ref: unknown.value }));
	}

	const stopping = closure(draft, refs);

	for (const [ref, by] of stopping) {
		if (!Draft.isGroup(Option.getOrThrow(Draft.find(draft, ref)))) {
			Draft.halt(draft, ref, FailReason.Stopped({ by }));
		}
	}

	const handed = Draft.hand(
		draft,
		Draft.deliverable(draft, (ref) => stopping.has(ref)),
	);

	return Result.succeed(Draft.finish(draft, handed));
};

export const Groups = { group, stop };
