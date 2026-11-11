import * as Brand from "effect/Brand";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { TerminalAddress, TerminalEnd } from "../../clients/hc/index.ts";
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

export type Outcome = Data.TaggedEnum<{
	Done: { readonly text: string };
	Fired: { readonly exitCode: number; readonly tail: string };
	Members: { readonly results: ReadonlyArray<Settled> };
	Failed: { readonly reason: FailReason };
}>;

export const Outcome = Data.taggedEnum<Outcome>();

export interface Settled {
	readonly ref: WorkRef;
	readonly kind: WorkKind;
	readonly outcome: Outcome;
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
	Delegate: Common & { readonly childSession: ChildSession; readonly spawn: Option.Option<Spawn> };
	Watch: Common & {
		readonly command: string;
		readonly deadline: Option.Option<Duration.Duration>;
		readonly spawn: Option.Option<Spawn>;
	};
	Serve: Common & { readonly command: string; readonly spawn: Option.Option<Spawn> };
	Group: Common & { readonly name: string; readonly members: ReadonlyArray<WorkRef> };
}>;

export const Work = Data.taggedEnum<Work>();

export type StartRequest = Data.TaggedEnum<{
	Delegate: { readonly brief: Brief; readonly childSession: ChildSession };
	Serve: { readonly command: string; readonly ready: Option.Option<string> };
	Watch: { readonly command: string; readonly deadline: Option.Option<Duration.Duration> };
}>;

export const StartRequest = Data.taggedEnum<StartRequest>();

export interface GroupRequest {
	readonly name: string;
	readonly members: ReadonlyArray<WorkRef>;
}

export class BadDelegate extends Schema.TaggedError<BadDelegate, { readonly brand: unique symbol }>()("BadDelegate", {
	why: Schema.String,
}) {}

export interface Handle {
	readonly ref: WorkRef;
	readonly kind: WorkKind;
	readonly terminal: Option.Option<TerminalAddress>;
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
		readonly end: Option.Option<TerminalEnd>;
		readonly durationMs: number;
	};
}>;

export const WorkEntry = Data.taggedEnum<WorkEntry>();
