import type { StopReason } from "@earendil-works/pi-ai";
import * as Data from "effect/Data";

import type { TerminalEnd } from "../../clients/hc/index.ts";
import type { Role } from "./child.ts";
import type { HeldSpawn } from "./world.fixture.ts";

export type Act = Data.TaggedEnum<{
	Hook: { readonly event: "run starts" | "goes idle" | "parent dies" | "pi reloads" };
	Start: {
		readonly kind: "delegate" | "serve" | "watch";
		readonly name?: string;
		readonly continues?: string;
		readonly message?: string;
		readonly refused?: string;
		readonly deadlineMs?: number;
		readonly messageKiB?: number;
		readonly instructionsKiB?: number;
		readonly heldThen?: HeldSpawn;
		readonly group?: string;
		readonly handle?: Readonly<Record<string, string | boolean>>;
	};
	Launched: {
		readonly terminal: string;
		readonly expect: (sessionIdOf: (terminal: string) => string) => Record<"session" | "brief" | "message", string>;
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
	Delivered: { readonly expect: (sessionIdOf: (terminal: string) => string) => ReadonlyArray<object> };
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
