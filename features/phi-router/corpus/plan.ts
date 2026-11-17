import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { Entry, type PhiStrata, TextCarrier, TextIdentifier, Transform } from "./manifest.ts";
import type { Random } from "./random.ts";

export interface TextStrata extends PhiStrata {
	readonly identifier: TextIdentifier;
	readonly carrier: TextCarrier;
}

const perIdentifier = 22;

const buriedCount = 10;

const unrealistic: ReadonlyArray<Partial<TextStrata>> = [
	{ carrier: "clinical-note", transform: "buried" },
	{ carrier: "ticket", transform: "buried" },
	{ transform: "buried", entry: "compaction-summary" },
	{ transform: "gzip-hex", entry: "compaction-summary" },
	// A summary never stops in the middle of an identifier.
	{ transform: "split", entry: "compaction-summary" },
	// A split cuts one identifier, and a companion identifier would stay whole beside it.
	{ transform: "split", identifier: "birth-date" },
	{ transform: "split", carrier: "x12-837" },
	// An ent reply quotes the payload lines that hold the identifier, which an encoded or split payload has none of.
	{ transform: "split", entry: "ent-reply" },
	{ transform: "buried", entry: "ent-reply" },
	{ transform: "base64", entry: "ent-reply" },
	{ transform: "gzip-hex", entry: "ent-reply" },
];

const axes = ["identifier", "carrier", "transform", "entry"] as const;

const isRealistic = (strata: Partial<TextStrata>) =>
	!Arr.some(unrealistic, (rule) => Arr.every(axes, (axis) => rule[axis] === undefined || rule[axis] === strata[axis]));

const deck = <Value>(rng: Random, values: ReadonlyArray<Value>, size: number) => {
	const cycled = Arr.flatten(Arr.replicate(values, Math.ceil(size / values.length)));

	return rng.shuffle(Arr.take(cycled, size));
};

const takeFitting = <Value>(
	rng: Random,
	left: Array<Value>,
	all: Arr.NonEmptyReadonlyArray<Value>,
	fits: (value: Value) => boolean,
) =>
	Option.match(Arr.findFirstIndex(left, fits), {
		onSome: (index) => left.splice(index, 1)[0] ?? Arr.headNonEmpty(all),
		onNone: () => Option.getOrElse(Arr.findFirst(rng.shuffle(all), fits), () => Arr.headNonEmpty(all)),
	});

/**
 * Deals the PHI strata like a Latin square: every axis value appears about equally often, combinations spread
 * at random, and an unrealistic combination is re-drawn.
 */
export const planStrata = (rng: Random): ReadonlyArray<TextStrata> => {
	const total = TextIdentifier.literals.length * perIdentifier;
	const unburied = Arr.filter(Transform.literals, (transform) => transform !== "buried");
	const identifiers = deck(rng, TextIdentifier.literals, total);

	const transforms = [
		...Arr.makeBy(buriedCount, () => "buried" as const),
		...deck(rng, unburied, total - buriedCount),
	];

	const carriers = deck(rng, TextCarrier.literals, total);
	const entries = deck(rng, Entry.literals, total);

	const plans = Arr.zipWith(identifiers, transforms, (identifier, transform) => {
		const carrier = takeFitting(rng, carriers, TextCarrier.literals, (value) =>
			isRealistic({ identifier, transform, carrier: value }),
		);

		const entry = takeFitting(rng, entries, Entry.literals, (value) =>
			isRealistic({ identifier, transform, carrier, entry: value }),
		);

		return { identifier, carrier, transform, entry };
	});

	return rng.shuffle(plans);
};
