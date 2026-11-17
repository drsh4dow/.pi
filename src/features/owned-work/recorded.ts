import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/** The `customType` of the entries the ledger writes, and of the results it hands the agent. */
export const entryKind = "owned-work";

const NumberedRef = Schema.String.check(Schema.isPattern(/^[a-z]+-\d+$/u));

const RecordedWork = Schema.Struct({
	type: Schema.Literal("custom"),
	customType: Schema.Literal(entryKind),
	data: Schema.Struct({ type: Schema.String, handle: NumberedRef }),
});

type Recorded = (typeof RecordedWork.Type)["data"];

const recordedIn = (entries: ReadonlyArray<SessionEntry>): ReadonlyArray<Recorded> =>
	Arr.getSomes(
		Arr.map(entries, (entry) => Option.map(Schema.decodeUnknownOption(RecordedWork)(entry), ({ data }) => data)),
	);

const numberOf = ({ handle }: Recorded): number => Number(Str.split(handle, "-")[1]);

/**
 * A fork or a resumed session already names work in its transcript, such as `delegate-3`, that this process never
 * started, so its own refs start past the highest one.
 */
export const firstRefAfter = (entries: ReadonlyArray<SessionEntry>): number =>
	Arr.reduce(Arr.map(recordedIn(entries), numberOf), 0, Math.max) + 1;

/** The work `entries` start and never settle, in the order they start it. */
export const unsettledRefs = (entries: ReadonlyArray<SessionEntry>): ReadonlyArray<string> => {
	const recorded = recordedIn(entries);
	const settled = new Set(Arr.flatMap(recorded, ({ type, handle }) => (type === "job-settled" ? [handle] : [])));

	return Arr.flatMap(recorded, ({ type, handle }) => (type !== "job-settled" && !settled.has(handle) ? [handle] : []));
};
