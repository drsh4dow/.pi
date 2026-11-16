import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { SafeHarbor } from "./policy/index.ts";

const Id = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u));

const AccountId = Schema.Literals(["ultra-a", "ultra-b", "ent"]);

/**
 * One routing decision. Every field is a literal, a number or an id, so no record can hold message content.
 *
 * `verdict` is what the scan found: `skipped` when the mode or the reason sent the request to the BAA account unscanned.
 * `detector` names what tainted or what failed.
 */
export const Lane = Schema.Struct({
	time: Schema.Finite,
	session: Id,
	leaf: Schema.NullOr(Id),
	reason: Schema.Literals(["user", "continuation", "retry", "direct"]),
	mode: Schema.Literals(["shadow", "enforce", "force-baa", "baa-repo", "bad-settings"]),
	verdict: Schema.Literals(["clean", "tainted", "unsure", "skipped"]),
	detector: Schema.optionalKey(
		Schema.Literals([
			"rule",
			"judge",
			"image",
			"binary",
			"undecodable",
			"judge-error",
			"judge-timeout",
			"too-large",
			"engine-defect",
		]),
	),
	category: Schema.optionalKey(SafeHarbor),
	wouldBe: AccountId,
	dispatched: AccountId,
	chars: Schema.Finite,
	newChars: Schema.Finite,
	judgeCalls: Schema.Finite,
	judgeMs: Schema.Finite,
});

export type Lane = typeof Lane.Type;

export const LaneLine = Schema.fromJsonString(Lane);

export const lanesFolder = Effect.map(Config.String("HOME"), (home) => `${home}/.local/state/pi-phi-router/lanes`);

export const appendLane = Effect.fn("appendLane")(function* (lane: Lane) {
	const fs = yield* FileSystem.FileSystem;
	const folder = yield* lanesFolder;
	const line = yield* Schema.encodeEffect(LaneLine)(lane);

	yield* fs.makeDirectory(folder, { recursive: true });
	yield* fs.writeFileString(`${folder}/${lane.session}.jsonl`, `${line}\n`, { flag: "a" });
});
