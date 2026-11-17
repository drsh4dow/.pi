import * as Brand from "effect/Brand";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { TerminalAddress, TerminalEnd } from "#src/client/hc/index.ts";
import type { VerdictRecord } from "#src/features/pr/index.ts";
import type { Brief, ChildSession } from "./child.ts";

export type WorkRef = string & Brand.Brand<"WorkRef">;

export const WorkRef = Brand.nominal<WorkRef>();

export type MonotonicNanos = bigint & Brand.Brand<"MonotonicNanos">;

export const MonotonicNanos = Brand.nominal<MonotonicNanos>();

export const monotonicNow = Effect.map(Clock.monotonicTimeNanos, MonotonicNanos);

export type WorkKind = "delegate" | "serve" | "watch" | "group";

export type FailReason = Data.TaggedEnum<{
	Oom: { readonly signal: number };
	Exited: { readonly code: Option.Option<number>; readonly signal: Option.Option<number> };
	Lost: { readonly why: string };
	Deadline: { readonly after: Duration.Duration };
	SpawnFailed: { readonly why: string };
	Errored: { readonly why: string };
	/** `group` is the group whose settling ended a serve; none when the agent's own `cancel` call did. */
	Cancelled: { readonly group: Option.Option<WorkRef> };
}>;

export const FailReason = Data.taggedEnum<FailReason>();

export interface Answer {
	readonly text: string;
	readonly cut: boolean;
	readonly file: string;
}

export interface Reviewed {
	readonly record: VerdictRecord;
	readonly escalation: Option.Option<string>;
}

export type Outcome = Data.TaggedEnum<{
	Done: { readonly answer: Answer; readonly verdict: Option.Option<Reviewed> };
	Fired: { readonly exitCode: number; readonly tail: string };
	Members: { readonly results: ReadonlyArray<Settled> };
	Failed: { readonly reason: FailReason };
}>;

export const Outcome = Data.taggedEnum<Outcome>();

export type Identity =
	| { readonly kind: "delegate"; readonly name: string; readonly session: string }
	| { readonly kind: "watch" | "serve"; readonly command: string }
	| { readonly kind: "group"; readonly name: string };

export interface Settled {
	readonly ref: WorkRef;
	readonly who: Identity;
	readonly outcome: Outcome;
	/** The file holding a watch's full output, once its command started. */
	readonly log: Option.Option<string>;
}

export interface Settlement {
	readonly outcome: Outcome;
	readonly delivered: boolean;
}

interface Common {
	readonly ref: WorkRef;
	readonly heldBy: Option.Option<WorkRef>;
	readonly startedAt: MonotonicNanos;
	readonly settled: Option.Option<Settlement>;
}

export interface Spawn {
	readonly terminal: TerminalAddress;
	readonly learnedAt: MonotonicNanos;
}

export type Work = Data.TaggedEnum<{
	Delegate: Common & {
		readonly brief: Brief;
		readonly childSession: ChildSession;
		readonly spawn: Option.Option<Spawn>;
	};
	Watch: Common & {
		readonly command: string;
		readonly deadline: Option.Option<Duration.Duration>;
		readonly log: string;
		readonly spawn: Option.Option<Spawn>;
	};
	Serve: Common & { readonly command: string; readonly spawn: Option.Option<Spawn> };
	Group: Common & { readonly name: string; readonly members: ReadonlyArray<WorkRef> };
}>;

export const Work = Data.taggedEnum<Work>();

export const whoOf = (work: Work): Identity =>
	Match.valueTags(work, {
		Delegate: ({ brief, childSession }): Identity => ({
			kind: "delegate",
			name: brief.name,
			session: childSession.id,
		}),
		Watch: ({ command }): Identity => ({ kind: "watch", command }),
		Serve: ({ command }): Identity => ({ kind: "serve", command }),
		Group: ({ name }): Identity => ({ kind: "group", name }),
	});

/** A watch has a log once its command started. */
export const logOf = (work: Work): Option.Option<string> =>
	Work.$is("Watch")(work) ? Option.as(work.spawn, work.log) : Option.none();

export type StartRequest = Data.TaggedEnum<{
	/** `group` names the group the delegate joins, or starts when none of that name is live. */
	Delegate: { readonly brief: Brief; readonly childSession: ChildSession; readonly group: Option.Option<string> };
	Serve: { readonly command: string; readonly ready: Option.Option<string> };
	Watch: { readonly command: string; readonly deadline: Option.Option<Duration.Duration>; readonly log: string };
}>;

export const StartRequest = Data.taggedEnum<StartRequest>();

export type DelegateStart = Data.TaggedEnum.Value<StartRequest, "Delegate">;

export interface ContinueRequest {
	readonly ref: WorkRef;
	readonly message: Option.Option<string>;
	readonly group: Option.Option<string>;
}

export interface GroupRequest {
	readonly name: string;
	readonly members: ReadonlyArray<WorkRef>;
}

export class BadDelegate extends Schema.TaggedError<BadDelegate, { readonly brand: unique symbol }>()("BadDelegate", {
	why: Schema.String,
}) {}

export class NameTaken extends Schema.TaggedError<NameTaken, { readonly brand: unique symbol }>()("NameTaken", {
	wanted: Schema.String,
	by: Schema.String,
}) {}

export class NotContinuable extends Schema.TaggedError<NotContinuable, { readonly brand: unique symbol }>()(
	"NotContinuable",
	{ ref: Schema.String, why: Schema.String },
) {}

export interface Handle {
	readonly ref: WorkRef;
	readonly kind: WorkKind;
	readonly terminal: Option.Option<TerminalAddress>;
	readonly group: Option.Option<WorkRef>;
	readonly ready: Option.Option<boolean>;
}

export type WorkEntry = Data.TaggedEnum<{
	DelegateStarted: {
		readonly handle: WorkRef;
		readonly name: string;
		readonly model: string;
		readonly instructionsFile: Option.Option<string>;
		readonly childSessionId: string;
	};
	CommandStarted: { readonly handle: WorkRef; readonly kind: "serve" | "watch"; readonly command: string };
	GroupStarted: {
		readonly handle: WorkRef;
		readonly name: string;
		readonly members: ReadonlyArray<WorkRef>;
	};
	JobSettled: {
		readonly handle: WorkRef;
		readonly outcome: Outcome;
		readonly log: Option.Option<string>;
		readonly end: Option.Option<TerminalEnd>;
		readonly durationMs: number;
	};
}>;

export const WorkEntry = Data.taggedEnum<WorkEntry>();
