import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/** A delegate a session started: its child session's id, and the name its parent gave it. */
export interface Started {
	readonly id: string;
	readonly name: string;
}

/**
 * What a session's lines add up to: the list price of every model call it made, and the delegates it started. `since`
 * is when the session began, from its header. A fork copies its source's entries with their timestamps, so an entry
 * older than the header was spent in the source.
 */
export interface Tally {
	readonly since: number;
	readonly usd: number;
	readonly started: ReadonlyArray<Started>;
}

/** Counts nothing until the header says when the session began. */
export const emptyTally: Tally = { since: Number.POSITIVE_INFINITY, usd: 0, started: [] };

const Priced = Schema.Struct({ cost: Schema.Struct({ total: Schema.Finite }) });

const DelegateStarted = Schema.Struct({
	type: Schema.Literal("delegate-started"),
	name: Schema.String,
	child_session_id: Schema.String,
});

/** Only the lines a tally reads, and only the fields it reads from them. */
const Line = Schema.Union([
	Schema.Struct({ type: Schema.Literal("session"), timestamp: Schema.String }),
	// A reply, or a tool result that called a model, carries its usage on the message.
	Schema.Struct({
		type: Schema.Literal("message"),
		timestamp: Schema.String,
		message: Schema.Struct({ usage: Priced }),
	}),
	// A compaction, a branch summary or a cache-warm call calls the model too, and carries its usage on the entry.
	Schema.Struct({
		type: Schema.Literals(["compaction", "branch_summary", "usage"]),
		timestamp: Schema.String,
		usage: Priced,
	}),
	Schema.Struct({
		type: Schema.Literal("custom"),
		customType: Schema.Literal("owned-work"),
		timestamp: Schema.String,
		data: DelegateStarted,
	}),
]);

type Line = typeof Line.Type;

const decodeLine = Schema.decodeOption(Schema.fromJsonString(Line));

/** A line can run to hundreds of kilobytes, so only one that can be counted is parsed. */
const mayCount = (text: string) =>
	Str.startsWith('{"type":"session"')(text) ||
	Str.includes('"usage":')(text) ||
	Str.includes('"delegate-started"')(text);

const add = (tally: Tally, line: Line): Tally => {
	if (line.type === "session") {
		return { ...tally, since: Date.parse(line.timestamp) };
	}

	if (Date.parse(line.timestamp) < tally.since) {
		return tally;
	}

	if (line.type === "custom") {
		return { ...tally, started: [...tally.started, { id: line.data.child_session_id, name: line.data.name }] };
	}

	const { usage } = line.type === "message" ? line.message : line;

	return { ...tally, usd: tally.usd + usage.cost.total };
};

/** Adds whole JSONL lines to a tally. */
export const tallyLines = ({ tally, text }: { readonly tally: Tally; readonly text: string }): Tally => {
	const countable = Arr.filter(Str.split(text, "\n"), mayCount);

	return Arr.reduce(Arr.getSomes(Arr.map(countable, (line) => decodeLine(line))), tally, add);
};
