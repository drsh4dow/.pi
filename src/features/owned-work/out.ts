import type { JsonValue } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Type } from "typebox";

import type { TerminalEnd } from "#src/client/hc/index.ts";
import { VerdictResult } from "#src/features/pr/index.ts";
import type { LedgerFailure } from "./ledger.ts";
import {
	type BadDelegate,
	FailReason,
	type Handle,
	type Identity,
	Outcome,
	type Reviewed,
	type Settled,
	type WorkEntry,
	type WorkKind,
	type WorkRef,
} from "./work.ts";

export const HandleOut = Type.Object({
	ref: Type.String(),
	kind: Type.Enum(["delegate", "serve", "watch", "group"]),
	terminal: Type.Optional(Type.String()),
	group: Type.Optional(Type.String()),
	ready: Type.Optional(Type.Boolean()),
	next: Type.Optional(Type.String()),
	/** Set when the whole delegate run lands on another model, because no BAA provider carries the one named. */
	substituted: Type.Optional(Type.String()),
});

const VerdictOut = Type.Object({
	pr: Type.String(),
	head: Type.String(),
	result: Type.Enum([...VerdictResult.literals]),
	escalation: Type.Optional(Type.String()),
});

const DoneOut = Type.Object({
	status: Type.Literal("done"),
	text: Type.String(),
	cut: Type.Boolean(),
	answer: Type.String(),
	verdict: Type.Optional(VerdictOut),
});

const LogOut = Type.Optional(Type.String());

const FiredOut = Type.Object({
	status: Type.Literal("fired"),
	exit_code: Type.Number(),
	log: LogOut,
	tail: Type.String(),
});

const FailedReason = Type.Enum(["oom", "exited", "lost", "deadline", "spawn-failed", "errored", "cancelled"]);

const FailedOut = Type.Object({
	status: Type.Literal("failed"),
	reason: FailedReason,
	detail: Type.String(),
	log: LogOut,
});

const SettledOut = Type.Object({ status: Type.Literal("settled"), members: Type.Array(Type.Ref("Result")) });

const Result = Type.Object({
	ref: Type.String(),
	kind: Type.String(),
	name: Type.Optional(Type.String()),
	session: Type.Optional(Type.String()),
	command: Type.Optional(Type.String()),
	outcome: Type.Union([DoneOut, FiredOut, FailedOut, SettledOut]),
	next: Type.Optional(Type.String()),
});

const ResultOut = Type.Cyclic({ Result }, "Result");

export const ResultsOut = Type.Object({ results: Type.Array(ResultOut) });

type ResultJson = Identity & { readonly ref: string; readonly outcome: OutcomeJson; readonly next?: string };

type OutcomeJson =
	| {
			readonly status: "done";
			readonly text: string;
			readonly cut: boolean;
			readonly answer: string;
			readonly verdict?: {
				readonly pr: string;
				readonly head: string;
				readonly result: string;
				readonly escalation?: string;
			};
	  }
	| { readonly status: "fired"; readonly exit_code: number; readonly log?: string; readonly tail: string }
	| { readonly status: "failed"; readonly reason: string; readonly detail: string; readonly log?: string }
	| {
			readonly status: "settled";
			readonly members: ReadonlyArray<ResultJson>;
	  };

const exitDetail = (code: Option.Option<number>, signal: Option.Option<number>): string =>
	Option.match(code, {
		onSome: (exitCode) => `exit code ${String(exitCode)}`,
		onNone: () => Option.match(signal, { onSome: (number) => `signal ${String(number)}`, onNone: () => "ended" }),
	});

const reasonOut = (reason: FailReason): { readonly reason: string; readonly detail: string } =>
	Match.valueTags(reason, {
		Oom: ({ signal }) => ({ reason: "oom", detail: `signal ${String(signal)} with no exit code` }),
		Exited: ({ code, signal }) => ({ reason: "exited", detail: exitDetail(code, signal) }),
		Lost: ({ why }) => ({ reason: "lost", detail: why }),
		Deadline: ({ after }) => ({ reason: "deadline", detail: `still running after ${Duration.format(after)}` }),
		SpawnFailed: ({ why }) => ({ reason: "spawn-failed", detail: why }),
		Errored: ({ why }) => ({ reason: "errored", detail: why }),
		Cancelled: ({ group }) => ({
			reason: "cancelled",
			detail: Option.match(group, {
				onNone: () => "cancelled by your cancel call",
				onSome: (ref) => `cancelled when ${ref} settled`,
			}),
		}),
	});

const logOut = (log: Option.Option<string>) =>
	Option.match(log, { onNone: () => ({}), onSome: (path) => ({ log: path }) });

const verdictOut = ({ record: { repo, number, head, result }, escalation }: Reviewed) => ({
	pr: `${repo}#${String(number)}`,
	head,
	result,
	...Option.match(escalation, { onNone: () => ({}), onSome: (line) => ({ escalation: line }) }),
});

const outcomeOut = (outcome: Outcome, log: Option.Option<string>): OutcomeJson =>
	Match.valueTags(outcome, {
		Done: ({ answer: { text, cut, file }, verdict }): OutcomeJson => ({
			status: "done",
			text,
			cut,
			answer: file,
			...Option.match(verdict, { onNone: () => ({}), onSome: (reviewed) => ({ verdict: verdictOut(reviewed) }) }),
		}),
		Fired: ({ exitCode, tail }): OutcomeJson => ({ status: "fired", exit_code: exitCode, ...logOut(log), tail }),
		Members: ({ results }): OutcomeJson => ({ status: "settled", members: Arr.map(results, resultOut) }),
		Failed: ({ reason }): OutcomeJson => ({ status: "failed", ...reasonOut(reason), ...logOut(log) }),
	});

const diedOnProviderError = ({ who, outcome }: Settled) =>
	who.kind === "delegate" && Outcome.$is("Failed")(outcome) && FailReason.$is("Errored")(outcome.reason);

const resultOut = (settled: Settled): ResultJson => {
	const result = { ref: settled.ref, ...settled.who, outcome: outcomeOut(settled.outcome, settled.log) };

	if (!diedOnProviderError(settled)) {
		return result;
	}

	return { ...result, next: `call delegate with continues "${settled.ref}" to run it again in its own session` };
};

/** How to wait for the work. A serve's end never wakes the agent, so its handle has none. */
const nextOf = (kind: WorkKind, waker: WorkRef) =>
	kind === "serve" ? {} : { next: `end your turn; ${waker} wakes you` };

const handleOut = ({ ref, kind, terminal, group, ready }: Handle) => ({
	ref,
	kind,
	...Option.match(terminal, { onNone: () => ({}), onSome: (address) => ({ terminal: address }) }),
	...Option.match(group, { onNone: () => ({}), onSome: (holder) => ({ group: holder }) }),
	...Option.match(ready, { onNone: () => ({}), onSome: (matched) => ({ ready: matched }) }),
	...nextOf(
		kind,
		Option.getOrElse(group, () => ref),
	),
});

const delegatedOut = ({
	handle,
	substitution,
}: {
	readonly handle: Handle;
	readonly substitution: Option.Option<string>;
}) => ({
	...handleOut(handle),
	...Option.match(substitution, { onNone: () => ({}), onSome: (substituted) => ({ substituted }) }),
});

const endOut = (end: Option.Option<TerminalEnd>) =>
	Option.match(end, {
		onNone: () => ({}),
		onSome: (ended) =>
			Match.valueTags(ended, {
				Exited: ({ code, signal }) => ({ exit_code: Option.getOrNull(code), signal: Option.getOrNull(signal) }),
				Lost: ({ reason }) => ({ hc_reason: reason }),
			}),
	});

const entryOut = (entry: WorkEntry) =>
	Match.valueTags(entry, {
		DelegateStarted: ({ handle, name, model, instructionsFile, childSessionId }) => ({
			type: "delegate-started",
			handle,
			name,
			model,
			instructions_file: Option.getOrNull(instructionsFile),
			child_session_id: childSessionId,
		}),
		CommandStarted: ({ handle, kind, name, command }) => ({ type: "command-started", handle, kind, name, command }),
		GroupStarted: ({ handle, name, members }) => ({ type: "group-started", handle, name, members }),
		JobSettled: ({ handle, outcome, log, end, durationMs }) => ({
			type: "job-settled",
			handle,
			outcome: outcomeOut(outcome, log),
			...endOut(end),
			duration_ms: durationMs,
		}),
	});

const errorText = (error: LedgerFailure | BadDelegate): string =>
	Match.valueTags(error, {
		BadDelegate: ({ why }) => why,
		UnknownRef: ({ ref }) => `no work is called ${ref}`,
		NotContinuable: ({ ref, why }) => `${ref} ${why}`,
		NameTaken: ({ wanted, by }) =>
			`${by} runs under the name "${wanted}"; pick another name, or wait for ${by} to settle`,
		NotYours: ({ ref, why }) => `${ref}: ${why}`,
		NoJobs: ({ refs }) => `a group needs a delegate or a watch, and ${Arr.join(refs, ", ")} are only serves`,
		HcError: ({ method, kind, message }) => `hc ${method} failed (${kind}): ${message}`,
		PlatformError: ({ message }) => message,
	});

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const text = (json: JsonValue): Effect.Effect<string> => Effect.orDie(encode(json));

export const Out = {
	handle: handleOut,
	delegated: delegatedOut,
	reason: reasonOut,
	result: resultOut,
	entry: entryOut,
	error: (error: LedgerFailure | BadDelegate) => ({ error: error._tag, message: errorText(error) }),
	text,
};
