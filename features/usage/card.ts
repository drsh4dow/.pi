import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { Money, Spend, Window } from "../../clients/claude-usage/index.ts";

/** One number `/usage` read for an account. */
export type Meter =
	| { readonly kind: "window"; readonly window: Window }
	/** Claude's extra usage: spend past the plan's limits this month. */
	| { readonly kind: "extra"; readonly spend: Spend }
	/** What pi priced its own replies at over the last `days` days. Other clients on the same key are not in it. */
	| { readonly kind: "estimate"; readonly usd: number; readonly replies: number; readonly days: number };

export type Outcome =
	| { readonly kind: "read"; readonly meters: ReadonlyArray<Meter> }
	| { readonly kind: "unreadable"; readonly why: string };

/**
 * A row as the card shows it. A gauge is a share of a limit, drawn as a bar. A note is a value with no limit to fill.
 * The card keeps rows, not meters, because the session stores it as JSON and shows it again as it was when read.
 */
const Gauge = Schema.Struct({
	kind: Schema.Literal("gauge"),
	name: Schema.String,
	percent: Schema.Finite,
	detail: Schema.String,
});

/** A quiet note tells of something switched off, so it reads dimmed. */
const Note = Schema.Struct({
	kind: Schema.Literal("note"),
	name: Schema.String,
	text: Schema.String,
	quiet: Schema.Boolean,
});

const Row = Schema.Union([Gauge, Note]);

/** Still waiting on the account, read, or failed with the reason the user reads. */
const Reading = Schema.Struct({ kind: Schema.Literal("reading") });

const Read = Schema.Struct({ kind: Schema.Literal("read"), rows: Schema.Array(Row) });

const Unreadable = Schema.Struct({ kind: Schema.Literal("unreadable"), why: Schema.String });

const Body = Schema.Union([Reading, Read, Unreadable]);

const Block = Schema.Struct({ account: Schema.String, via: Schema.String, body: Body });

/** What one `/usage` shows: a block per account, and when it was read. */
export const Card = Schema.Struct({ readAt: Schema.String, blocks: Schema.Array(Block) });

export type Row = typeof Row.Type;

export type Block = typeof Block.Type;

export type Card = typeof Card.Type;

const moneyText = ({ minor, exponent, currency }: Money) =>
	new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 10 ** exponent);

const usdText = (usd: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(usd);

/** Time until a reset, coarse enough to read at a glance: `1d 6h`, `5h 12m`, `40m`. */
const untilText = (left: Duration.Duration) => {
	const minutes = Math.max(0, Math.round(Duration.toMinutes(left)));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);

	if (days > 0) {
		return `${days}d ${hours}h`;
	}

	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`;
	}

	return `${minutes}m`;
};

const windowRow = ({ name, percent, resetsAt }: Window, now: DateTime.Utc): Row => ({
	kind: "gauge",
	name,
	percent,
	detail: Option.match(resetsAt, {
		onNone: () => "",
		onSome: (at) => `resets in ${untilText(DateTime.distance(now, at))}`,
	}),
});

const extraRow = ({ used, cap, off }: Spend): Row => {
	const spent = Option.match(cap, {
		onNone: () => moneyText(used),
		onSome: (limit) => `${moneyText(used)} of ${moneyText(limit)} this month`,
	});

	if (Option.isSome(off)) {
		return { kind: "note", name: "extra usage", text: `off (${off.value}) · ${spent}`, quiet: true };
	}

	return Option.match(cap, {
		onNone: () => ({ kind: "note", name: "extra usage", text: spent, quiet: false }),
		onSome: (limit) => ({
			kind: "gauge",
			name: "extra usage",
			percent: limit.minor === 0 ? 0 : (used.minor / limit.minor) * 100,
			detail: spent,
		}),
	});
};

const rowOf = (meter: Meter, now: DateTime.Utc): Row => {
	switch (meter.kind) {
		case "window": {
			return windowRow(meter.window, now);
		}

		case "extra": {
			return extraRow(meter.spend);
		}

		case "estimate": {
			const replies = meter.replies.toLocaleString("en-US");

			return {
				kind: "note",
				name: `last ${meter.days} days`,
				text: `${usdText(meter.usd)} over ${replies} replies`,
				quiet: false,
			};
		}

		default: {
			const unhandled: never = meter;

			return unhandled;
		}
	}
};

/** An account's block once its reading is in. */
export const blockOf = ({ outcome, now }: { readonly outcome: Outcome; readonly now: DateTime.Utc }) => {
	switch (outcome.kind) {
		case "read": {
			return { kind: "read" as const, rows: Arr.map(outcome.meters, (meter) => rowOf(meter, now)) };
		}

		case "unreadable": {
			return { kind: "unreadable" as const, why: outcome.why };
		}

		default: {
			const unhandled: never = outcome;

			return unhandled;
		}
	}
};

export const readAtOf = (now: DateTime.Utc) =>
	DateTime.formatLocal(now, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

type Paint = Pick<Theme, "fg" | "bold">;

const barCells = 10;

/** Green while there is room, yellow from 75%, red from 90%. */
const severityOf = (percent: number) => {
	if (percent >= 90) {
		return "error" as const;
	}

	if (percent >= 75) {
		return "warning" as const;
	}

	return "success" as const;
};

const gaugeText = (theme: Paint, percent: number) => {
	const filled = Math.min(barCells, Math.max(0, Math.round(percent / barCells)));
	const color = severityOf(percent);
	const bar = `${theme.fg(color, Str.repeat(filled)("█"))}${theme.fg("dim", Str.repeat(barCells - filled)("░"))}`;

	return `${bar} ${theme.fg(color, Str.padStart(4)(`${Math.round(percent)}%`))}`;
};

const rowLine = (theme: Paint, width: number) => (row: Row) => {
	const name = theme.fg("muted", Str.padEnd(width)(row.name));

	switch (row.kind) {
		case "gauge": {
			return `  ${name}  ${gaugeText(theme, row.percent)}  ${theme.fg("dim", row.detail)}`;
		}

		case "note": {
			return `  ${name}  ${row.quiet ? theme.fg("dim", row.text) : row.text}`;
		}

		default: {
			const unhandled: never = row;

			return unhandled;
		}
	}
};

const bodyLines = (theme: Paint, width: number, body: Block["body"]) => {
	switch (body.kind) {
		case "reading": {
			return [`  ${theme.fg("dim", "reading…")}`];
		}

		case "read": {
			return Arr.isReadonlyArrayNonEmpty(body.rows)
				? Arr.map(body.rows, rowLine(theme, width))
				: [`  ${theme.fg("dim", "nothing to report")}`];
		}

		case "unreadable": {
			return [`  ${theme.fg("error", `can't read: ${body.why}`)}`];
		}

		default: {
			const unhandled: never = body;

			return unhandled;
		}
	}
};

const nameWidth = (blocks: ReadonlyArray<Block>) => {
	const rows = Arr.flatMap(blocks, ({ body }) => (body.kind === "read" ? body.rows : []));

	return Arr.reduce(rows, 0, (widest, { name }) => Math.max(widest, name.length));
};

/** The blocks as lines: each account's name and source, then its rows, with the row names in one column. */
export const blockLines = ({ blocks, theme }: { readonly blocks: ReadonlyArray<Block>; readonly theme: Paint }) => {
	const width = nameWidth(blocks);

	return Arr.flatMap(blocks, ({ account, via, body }, index) => [
		...(index === 0 ? [] : [""]),
		`${theme.fg("accent", theme.bold(account))}  ${theme.fg("dim", via)}`,
		...bodyLines(theme, width, body),
	]);
};
