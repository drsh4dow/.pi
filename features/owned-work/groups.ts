import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
	Command,
	Draft,
	type Group,
	type LedgerError,
	type LedgerState,
	NoJobs,
	NotYours,
	type Step,
	type Woke,
	UnknownRef,
} from "./step.ts";
import { FailReason, type GroupRequest, type Handle, Work, WorkEntry, WorkRef } from "./work.ts";

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

	return Option.as(delivered, NotYours.make({ ref, why: "its result was already delivered" }));
};

const sameGroup = (work: Work, members: ReadonlyArray<WorkRef>): boolean =>
	Work.$is("Group")(work) &&
	work.members.length === members.length &&
	Arr.every(members, (ref) => work.members.includes(ref));

const rejected = (draft: Draft, members: ReadonlyArray<WorkRef>): Option.Option<LedgerError> => {
	const problem = Arr.findFirst(members, (ref) => refused(draft, ref));
	const hasJob = Arr.some(members, (ref) => Option.isSome(Draft.job(draft, ref)));

	return Option.isSome(problem) || hasJob ? problem : Option.some(NoJobs.make({ refs: members }));
};

/** The group's name on each member that has a terminal; a member still spawning gets it once it spawns. */
const showInGroup = (draft: Draft, holder: Group, members: ReadonlyArray<Work>): void => {
	for (const terminal of Arr.getSomes(Arr.map(members, Draft.terminalOf))) {
		draft.commands.push(Command.ShowInGroup({ terminal, group: holder.ref, name: holder.name }));
	}
};

const adopt = (draft: Draft, { name, members }: GroupRequest): Work => {
	const ref = WorkRef(`group-${String(draft.next)}`);

	const created = Work.Group({
		ref,
		heldBy: Option.none(),
		startedAt: draft.now,
		settled: Option.none(),
		name,
		members,
	});

	draft.next += 1;
	draft.work.set(ref, created);

	for (const member of Draft.findAll(draft, members)) {
		draft.work.set(member.ref, { ...member, heldBy: Option.some(ref) });
	}

	draft.commands.push(Command.Append({ entry: WorkEntry.GroupStarted({ handle: ref, name, members }) }));
	showInGroup(draft, created, Arr.filter(Draft.findAll(draft, members), Draft.isLive));
	Draft.settleGroup(draft, created);

	return created;
};

/** A delegate started with a group's name joins the live group of that name the agent holds, or starts one. */
const join = (draft: Draft, name: string, member: WorkRef): void => {
	const open = Arr.findFirst(
		Arr.filter([...draft.work.values()], Draft.isGroup),
		(holder) => holder.name === name && Draft.isLive(holder) && Option.isNone(holder.heldBy),
	);

	if (Option.isNone(open)) {
		adopt(draft, { name, members: [member] });

		return;
	}

	draft.work.set(open.value.ref, { ...open.value, members: [...open.value.members, member] });

	for (const work of Draft.findAll(draft, [member])) {
		draft.work.set(member, { ...work, heldBy: Option.some(open.value.ref) });
	}
};

const group = (state: LedgerState, request: GroupRequest): Result.Result<Step<Handle>, LedgerError> => {
	const draft = Draft.of(state);
	const members = Arr.dedupe(request.members);
	const same = Arr.findFirst(draft.work.values(), (work) => sameGroup(work, members));
	const problem = Option.isSome(same) ? Option.none() : rejected(draft, members);

	if (Option.isSome(problem)) {
		return Result.fail(problem.value);
	}

	const created = Option.getOrElse(same, () => adopt(draft, { ...request, members }));

	return Result.succeed(Draft.finish(draft, Draft.handleOf(created)));
};

const closure = (draft: Draft, refs: ReadonlyArray<WorkRef>): Set<WorkRef> => {
	const found = new Set<WorkRef>();

	const visit = (ref: WorkRef): void => {
		const work = draft.work.get(ref);

		if (work !== undefined && !found.has(ref)) {
			found.add(ref);

			for (const member of Work.$is("Group")(work) ? work.members : []) {
				visit(member);
			}
		}
	};

	for (const ref of refs) {
		visit(ref);
	}

	return found;
};

/** `ref` and each group above it: a cancelled member can be the last job its holders waited on. */
const withHolders = (draft: Draft, ref: WorkRef): Array<WorkRef> => {
	const holder = Option.flatMap(Draft.find(draft, ref), (work) => work.heldBy);

	return Option.match(holder, {
		onNone: () => [ref],
		onSome: (above) => [ref, ...withHolders(draft, above)],
	});
};

const cancel = (state: LedgerState, refs: ReadonlyArray<WorkRef>): Result.Result<Woke, UnknownRef> => {
	const draft = Draft.of(state);
	const unknown = Arr.findFirst(refs, (ref) => !draft.work.has(ref));

	if (Option.isSome(unknown)) {
		return Result.fail(UnknownRef.make({ ref: unknown.value }));
	}

	const cancelling = closure(draft, refs);

	for (const work of Arr.filter(Draft.findAll(draft, [...cancelling]), (found) => !Draft.isGroup(found))) {
		Draft.halt(draft, work.ref, FailReason.Cancelled({ group: Option.none() }));
	}

	const reached = new Set(Arr.flatMap([...cancelling], (ref) => withHolders(draft, ref)));

	const handed = Draft.hand(
		draft,
		Draft.deliverable(draft, (ref) => reached.has(ref)),
	);

	return Result.succeed(Draft.finish(draft, handed));
};

export const Groups = { group, join, cancel, showInGroup };
