/** What one corpus case did on the wire, and the per-stratum table the corpus wire scenario prints. */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { Case } from "./corpus/manifest.ts";

export interface Outcome {
	readonly id: string;
	readonly expect: Case["expect"];
	/** `entry=steering`, `transform=base64`, `negative=look-alike`, and so on. */
	readonly strata: ReadonlyArray<string>;
	/** Requests that reached a personal mock, and those the router sent to the `ent` mock: compactions go there direct. */
	readonly personal: number;
	readonly ent: number;
	/** Tokens of the case's PHI found in a personal mock's bodies. */
	readonly leaked: ReadonlyArray<string>;
	/** Tokens of the case's PHI no `ent` body carried, and canaries the run could not turn into tokens. */
	readonly missing: ReadonlyArray<string>;
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

/** A case fails the gate when its PHI reached a personal mock, did not all reach `ent`, or pi broke on it. */
export const failed = (outcome: Outcome) =>
	outcome.leaked.length > 0 || outcome.missing.length > 0 || Option.isSome(outcome.broken);

const columns = ["stratum", "N", "leaked", "not delivered", "broken", "personal", "ent"];

const rowOf = (stratum: string, outcomes: ReadonlyArray<Outcome>) => {
	const count = (predicate: (outcome: Outcome) => boolean) => String(Arr.filter(outcomes, predicate).length);

	return [
		stratum,
		String(outcomes.length),
		count(({ leaked }) => leaked.length > 0),
		count(({ missing, broken }) => missing.length > 0 && Option.isNone(broken)),
		count(({ broken }) => Option.isSome(broken)),
		count(({ personal }) => personal > 0),
		count(({ ent }) => ent > 0),
	];
};

const width = 28;

/**
 * One row per stratum, then one for all PHI cases and one for all clean ones. `personal` and `ent` count the cases with
 * at least one request on that lane, so a clean case under `ent` is one the router sent to the BAA account.
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
