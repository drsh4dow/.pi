import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { Money, Spend, Window } from "../../clients/claude-usage/index.ts";

/** One number `/usage` prints for an account. */
export type Meter =
	| { readonly kind: "window"; readonly window: Window }
	/** Claude's extra usage: spend past the plan's limits this month. */
	| { readonly kind: "extra"; readonly spend: Spend }
	/** What pi priced its own replies at over the last `days` days. Other clients on the same key are not in it. */
	| { readonly kind: "estimate"; readonly usd: number; readonly replies: number; readonly days: number };

export type Outcome =
	| { readonly kind: "read"; readonly meters: ReadonlyArray<Meter> }
	| { readonly kind: "unreadable"; readonly why: string };

export interface Reading {
	readonly account: string;
	/** Where the numbers come from, such as the account's usage page or a one-token probe. */
	readonly via: string;
	readonly outcome: Outcome;
}

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

const windowLine = ({ percent, resetsAt }: Window, now: DateTime.Utc) => {
	const used = Str.padStart(4)(`${Math.round(percent)}%`);

	const reset = Option.match(resetsAt, {
		onNone: () => "",
		onSome: (at) => `  resets in ${untilText(DateTime.distance(now, at))}`,
	});

	return `${used}${reset}`;
};

const extraLine = ({ used, cap, off }: Spend) => {
	const amount = Option.match(cap, {
		onNone: () => moneyText(used),
		onSome: (limit) => {
			const percent = limit.minor === 0 ? 0 : Math.round((used.minor / limit.minor) * 100);

			return `${moneyText(used)} of ${moneyText(limit)} (${percent}%) this month`;
		},
	});

	return Option.match(off, { onNone: () => amount, onSome: (why) => `off (${why}) · ${amount}` });
};

const meterRow = (meter: Meter, now: DateTime.Utc): readonly [string, string] => {
	switch (meter.kind) {
		case "window": {
			return [meter.window.name, windowLine(meter.window, now)];
		}

		case "extra": {
			return ["extra usage", extraLine(meter.spend)];
		}

		case "estimate": {
			return [
				`last ${meter.days} days`,
				`${usdText(meter.usd)} over ${meter.replies.toLocaleString("en-US")} replies`,
			];
		}

		default: {
			const unhandled: never = meter;

			return unhandled;
		}
	}
};

const readingLines = ({ account, via, outcome }: Reading, now: DateTime.Utc, width: number) => {
	switch (outcome.kind) {
		case "read": {
			const rows = Arr.map(outcome.meters, (meter) => meterRow(meter, now));

			const body = Arr.isReadonlyArrayNonEmpty(rows)
				? Arr.map(rows, ([name, value]) => `  ${Str.padEnd(width)(name)}  ${value}`)
				: ["  nothing to report"];

			return [`${account} · ${via}`, ...body];
		}

		case "unreadable": {
			return [`${account} · ${via}`, `  can't read: ${outcome.why}`];
		}

		default: {
			const unhandled: never = outcome;

			return unhandled;
		}
	}
};

/** Every reading as one block of text, with the meter names lined up in one column. */
export const reportOf = ({
	readings,
	now,
}: {
	readonly readings: ReadonlyArray<Reading>;
	readonly now: DateTime.Utc;
}) => {
	const names = Arr.flatMap(readings, ({ outcome }) =>
		outcome.kind === "read" ? Arr.map(outcome.meters, (meter) => meterRow(meter, now)[0]) : [],
	);

	const width = Arr.reduce(names, 0, (widest, name) => Math.max(widest, name.length));

	return Arr.join(
		Arr.flatMap(readings, (reading) => readingLines(reading, now, width)),
		"\n",
	);
};
