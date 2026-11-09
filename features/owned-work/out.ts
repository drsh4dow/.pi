import type { JsonValue } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Type } from "typebox";

import type { TerminalEnd } from "../../clients/hc/index.ts";
import type { LedgerFailure } from "./ledger.ts";
import type { BadDelegate, FailReason, Handle, Outcome, Settled, WorkEntry } from "./work.ts";

export const HandleOut = Type.Object({
	ref: Type.String(),
	kind: Type.Enum(["delegate", "serve", "watch", "group"]),
	terminal: Type.Optional(Type.String()),
	ready: Type.Optional(Type.Boolean()),
});

const DoneOut = Type.Object({ status: Type.Literal("done"), text: Type.String() });

const FiredOut = Type.Object({ status: Type.Literal("fired"), exit_code: Type.Number(), tail: Type.String() });

const FailedReason = Type.Enum(["oom", "exited", "lost", "deadline", "spawn-failed", "errored", "stopped"]);

const FailedOut = Type.Object({ status: Type.Literal("failed"), reason: FailedReason, detail: Type.String() });

const MemberOut = Type.Object({ ref: Type.String(), outcome: Type.Ref("Outcome") });

const SettledOut = Type.Object({ status: Type.Literal("settled"), members: Type.Array(MemberOut) });

const OutcomeOut = Type.Cyclic({ Outcome: Type.Union([DoneOut, FiredOut, FailedOut, SettledOut]) }, "Outcome");

const ResultOut = Type.Object({ ref: Type.String(), kind: Type.String(), outcome: OutcomeOut });

export const ResultsOut = Type.Object({ results: Type.Array(ResultOut) });

type OutcomeJson =
	| { readonly status: "done"; readonly text: string }
	| { readonly status: "fired"; readonly exit_code: number; readonly tail: string }
	| { readonly status: "failed"; readonly reason: string; readonly detail: string }
	| {
			readonly status: "settled";
			readonly members: ReadonlyArray<{ readonly ref: string; readonly outcome: OutcomeJson }>;
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
		Stopped: ({ by }) => ({ reason: "stopped", detail: `stopped by ${by}` }),
	});

const outcomeOut = (outcome: Outcome): OutcomeJson =>
	Match.valueTags(outcome, {
		Done: ({ text }): OutcomeJson => ({ status: "done", text }),
		Fired: ({ exitCode, tail }): OutcomeJson => ({ status: "fired", exit_code: exitCode, tail }),
		Members: ({ results }): OutcomeJson => ({
			status: "settled",
			members: Arr.map(results, ({ ref, outcome: member }) => ({ ref, outcome: outcomeOut(member) })),
		}),
		Failed: ({ reason }): OutcomeJson => ({ status: "failed", ...reasonOut(reason) }),
	});

const handleOut = ({ ref, kind, terminal, ready }: Handle) => ({
	ref,
	kind,
	...Option.match(terminal, { onNone: () => ({}), onSome: (address) => ({ terminal: address }) }),
	...Option.match(ready, { onNone: () => ({}), onSome: (matched) => ({ ready: matched }) }),
});

const resultOut = ({ ref, kind, outcome }: Settled) => ({ ref, kind, outcome: outcomeOut(outcome) });

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
		CommandStarted: ({ handle, kind, command }) => ({ type: "command-started", handle, kind, command }),
		GroupStarted: ({ handle, mode, members }) => ({ type: "group-started", handle, mode, members }),
		JobSettled: ({ handle, outcome, end, durationMs }) => ({
			type: "job-settled",
			handle,
			outcome: outcomeOut(outcome),
			...endOut(end),
			duration_ms: durationMs,
		}),
	});

const errorText = (error: LedgerFailure | BadDelegate): string =>
	Match.valueTags(error, {
		BadDelegate: ({ why }) => why,
		UnknownRef: ({ ref }) => `no work is called ${ref}`,
		NotYours: ({ ref, why }) => `${ref}: ${why}`,
		NoJobs: ({ refs }) => `a group needs a delegate or a watch, and ${Arr.join(refs, ", ")} are only serves`,
		HcError: ({ method, kind, message }) => `hc ${method} failed (${kind}): ${message}`,
		PlatformError: ({ message }) => message,
	});

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const text = (json: JsonValue): Effect.Effect<string> => Effect.orDie(encode(json));

export const Out = {
	handle: handleOut,
	result: resultOut,
	entry: entryOut,
	error: (error: LedgerFailure | BadDelegate) => ({ error: error._tag, message: errorText(error) }),
	text,
};
