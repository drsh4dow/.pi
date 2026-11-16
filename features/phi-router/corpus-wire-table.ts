/** What one corpus case did on the wire, and the per-stratum table the corpus wire scenario prints. */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { Seen } from "./canary-tokens.ts";
import type { Case } from "./corpus/manifest.ts";

export interface Outcome extends Seen {
	readonly id: string;
	readonly expect: Case["expect"];
	/** `entry=steering`, `transform=base64`, `negative=look-alike`, and so on. */
	readonly strata: ReadonlyArray<string>;
	/** Requests that reached a personal mock, and those the router sent to the `ent` mock: compactions go there direct. */
	readonly personal: number;
	readonly ent: number;
	/** Why pi did not play the case through. */
	readonly broken: Option.Option<string>;
}

export const strataOf = (subject: Case) =>
	subject.expect === "phi"
		? [
				`entry=${subject.strata.entry}`,
				`transform=${subject.strata.transform}`,
				`identifier=${subject.strata.identifier}`,
				`carrier=${subject.strata.carrier}`,
			]
		: [`negative=${subject.strata.negative}`];

/**
 * A case fails the gate when a complete identifier or a sealed message reached a personal mock, its PHI did not all reach
 * `ent`, or pi broke on it. A fragment on a personal mock is reported and passes.
 */
export const failed = (outcome: Outcome) =>
	outcome.leaked.length > 0 ||
	outcome.unsealed.length > 0 ||
	outcome.missing.length > 0 ||
	Option.isSome(outcome.broken);

const columns = ["stratum", "N", "leaked", "unsealed", "fragments", "not delivered", "broken", "personal", "ent"];

const rowOf = (stratum: string, outcomes: ReadonlyArray<Outcome>) => {
	const count = (predicate: (outcome: Outcome) => boolean) => String(Arr.filter(outcomes, predicate).length);

	return [
		stratum,
		String(outcomes.length),
		count(({ leaked }) => leaked.length > 0),
		count(({ unsealed }) => unsealed.length > 0),
		count(({ fragments }) => fragments.length > 0),
		count(({ missing, broken }) => missing.length > 0 && Option.isNone(broken)),
		count(({ broken }) => Option.isSome(broken)),
		count(({ personal }) => personal > 0),
		count(({ ent }) => ent > 0),
	];
};

const width = 28;

/**
 * One row per stratum, then one for all PHI cases and one for all clean ones. `personal` and `ent` count the cases with
 * at least one request on that lane, so a clean case under `ent` is one the router sent to the BAA account. `fragments`
 * counts cases with a fragment on a personal mock, which is no leak.
 */
export const tableOf = (outcomes: ReadonlyArray<Outcome>) => {
	const strata = Arr.sort(Arr.dedupe(Arr.flatMap(outcomes, ({ strata: labels }) => labels)), Str.Order);
	const within = (stratum: string) => Arr.filter(outcomes, ({ strata: labels }) => Arr.contains(labels, stratum));

	const rows = [
		columns,
		...Arr.map(strata, (stratum) => rowOf(stratum, within(stratum))),
		rowOf(
			"all phi",
			Arr.filter(outcomes, ({ expect }) => expect === "phi"),
		),
		rowOf(
			"all clean",
			Arr.filter(outcomes, ({ expect }) => expect === "clean"),
		),
	];

	return Arr.join(
		Arr.map(rows, ([stratum = "", ...counts]) =>
			Arr.join([Str.padEnd(width)(stratum), ...Arr.map(counts, Str.padStart(14))], ""),
		),
		"\n",
	);
};

/** Whether each clean case reached a personal mock, one line per case, then the share that did. */
export const cleanReachOf = (outcomes: ReadonlyArray<Outcome>) => {
	const clean = Arr.filter(outcomes, ({ expect }) => expect === "clean");
	const reached = Arr.filter(clean, ({ personal }) => personal > 0);
	const percent = clean.length === 0 ? 0 : Math.round((reached.length / clean.length) * 1000) / 10;

	return {
		reached: reached.length,
		lines: [
			...Arr.map(clean, ({ id, personal }) => `${id}\t${personal > 0 ? "personal" : "ent only"}`),
			`clean cases on a personal mock: ${String(reached.length)} of ${String(clean.length)} (${String(percent)}%)`,
		],
	};
};
