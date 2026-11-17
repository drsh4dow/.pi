import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Static } from "typebox";

import type { DelegateParams } from "./brief.ts";
import { Draft, type LedgerState, UnknownRef } from "./step.ts";
import {
	BadDelegate,
	type ContinueRequest,
	type DelegateStart,
	NotContinuable,
	StartRequest,
	Work,
	WorkRef,
} from "./work.ts";

export const continueMessage =
	"You run again in your own session. If your last turn ended in a tool call, check what that call already did, such as the files it changed or the commands it started, before you run it again. Then finish your task.";

const required = (value: string | undefined, field: string) =>
	Effect.fromOption(Option.fromUndefinedOr(value), () =>
		BadDelegate.make({ why: `name a \`${field}\`, which only a call with \`continues\` leaves out` }),
	);

export const freshCall = (call: Static<DelegateParams>) =>
	Effect.map(Effect.all([required(call.name, "name"), required(call.message, "message")]), ([name, message]) => ({
		...call,
		name,
		message,
	}));

const keptByContinuation = [
	"name",
	"goal",
	"state",
	"role",
	"design",
	"instructionsFile",
	"model",
	"cwd",
	"reviews",
] as const;

export const parseContinuation = Effect.fn("parseContinuation")(function* (ref: string, call: Static<DelegateParams>) {
	const named = Arr.filter(keptByContinuation, (field) => call[field] !== undefined);

	if (Arr.isReadonlyArrayNonEmpty(named)) {
		const fields = Arr.join(
			Arr.map(named, (field) => `\`${field}\``),
			", ",
		);

		return yield* BadDelegate.make({ why: `a continuation keeps the brief it started with: leave out ${fields}` });
	}

	const request: ContinueRequest = {
		ref: WorkRef(ref),
		message: Option.fromUndefinedOr(call.message),
		group: Option.fromUndefinedOr(call.group),
	};

	return request;
});

export const continuationOf =
	(state: LedgerState) =>
	({ ref, message, group }: ContinueRequest): Result.Result<DelegateStart, UnknownRef | NotContinuable> => {
		const work = state.work.get(ref);

		if (work === undefined) {
			return Result.fail(UnknownRef.make({ ref }));
		}

		if (!Work.$is("Delegate")(work)) {
			return Result.fail(NotContinuable.make({ ref, why: `is a ${Draft.kindOf(work)}, not a delegate` }));
		}

		if (Draft.isLive(work)) {
			return Result.fail(NotContinuable.make({ ref, why: "still runs; continue it once it settles" }));
		}

		const brief = { ...work.brief, message: Option.getOrElse(message, () => continueMessage) };

		return Result.succeed(StartRequest.Delegate({ brief, childSession: work.childSession, group }));
	};
