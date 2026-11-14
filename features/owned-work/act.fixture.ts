import type { StopReason } from "@earendil-works/pi-ai";
import * as Data from "effect/Data";

import type { TerminalEnd } from "../../clients/hc/index.ts";
import type { Role } from "./child.ts";
import type { HeldSpawn } from "./world.fixture.ts";

/** One step of a ledger row: something the agent or the outside world does, or a check of what the agent sees. */
export type Act = Data.TaggedEnum<{
	Hook: { readonly event: "run starts" | "goes idle" | "parent dies" | "pi reloads" };
	Start: {
		readonly kind: "delegate" | "serve" | "watch";
		/** A delegate's name, `Review <n>` for the nth delegate of the row by default. */
		readonly name?: string;
		/** The refusal the start fails with, before anything spawns. */
		readonly refused?: string;
		readonly deadlineMs?: number;
		readonly messageKiB?: number;
		readonly instructionsKiB?: number;
		readonly heldThen?: HeldSpawn;
		readonly group?: string;
		readonly handle?: Readonly<Record<string, string | boolean>>;
	};
	Spawned: { readonly expect: string };
	Resync: { readonly askedMsAgo: number };
	Answer: {
		readonly terminal: string;
		readonly text: string;
		readonly closing?: string;
		readonly stopReason?: StopReason;
		readonly end: TerminalEnd;
	};
	End: { readonly terminal: string; readonly end: TerminalEnd };
	Group: { readonly refs: ReadonlyArray<string>; readonly expect: string };
	Cancel: { readonly refs: ReadonlyArray<string>; readonly expect: string };
	Running: { readonly expect: ReadonlyArray<string> };
	Waking: { readonly expect: ReadonlyArray<string> };
	TurnEnds: { readonly expect: string };
	Wakes: { readonly expect: ReadonlyArray<string> };
	/** Every result handed to the agent so far, as the JSON it reads. `session` turns a terminal into its child's session id. */
	Delivered: { readonly expect: (session: (terminal: string) => string) => ReadonlyArray<object> };
	/** What each answer file the delivered results name holds. */
	AnswerFiles: { readonly expect: ReadonlyArray<string> };
	Killed: { readonly expect: ReadonlyArray<string> };
	Settles: { readonly expect: ReadonlyArray<string> };
	Leftovers: { readonly expect: ReadonlyArray<string> };
	Slices: { readonly expect: ReadonlyArray<string> };
	SpawnLevels: { readonly expect: ReadonlyArray<string> };
	Shown: { readonly expect: ReadonlyArray<string> };
	Timers: { readonly expect: number };
	WallClockSteps: { readonly backMs: number };
	Pause: { readonly ms: number };
}>;

export const Act = Data.taggedEnum<Act>();

export interface Row {
	readonly name: string;
	readonly role: Role;
	readonly acts: ReadonlyArray<Act>;
}
