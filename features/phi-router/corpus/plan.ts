import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { SafeHarbor } from "../policy/index.ts";
import { Carrier, Entry, type PhiStrata, Transform } from "./manifest.ts";
import type { Random } from "./random.ts";

const perIdentifier = 22;

const buriedCount = 10;

const unrealistic: ReadonlyArray<Partial<PhiStrata>> = [
	{ identifier: "url", carrier: "file-name" },
	{ identifier: "biometric", carrier: "file-name" },
	{ carrier: "screenshot", transform: "base64" },
	{ carrier: "screenshot", transform: "gzip-hex" },
	{ carrier: "screenshot", transform: "buried" },
	{ carrier: "screenshot", entry: "compaction-summary" },
	{ carrier: "clinical-note", transform: "buried" },
	{ carrier: "ticket", transform: "buried" },
	{ transform: "buried", entry: "compaction-summary" },
	{ transform: "gzip-hex", entry: "compaction-summary" },
];

const axes = ["identifier", "carrier", "transform", "entry"] as const;

const isRealistic = (strata: Partial<PhiStrata>) =>
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
export const planStrata = (rng: Random): ReadonlyArray<PhiStrata> => {
	const total = SafeHarbor.literals.length * perIdentifier;
	const unburied = Arr.filter(Transform.literals, (transform) => transform !== "buried");
	const identifiers = deck(rng, SafeHarbor.literals, total);

	const transforms = [
		...Arr.makeBy(buriedCount, () => "buried" as const),
		...deck(rng, unburied, total - buriedCount),
	];

	const carriers = deck(rng, Carrier.literals, total);
	const entries = deck(rng, Entry.literals, total);

	const plans = Arr.zipWith(identifiers, transforms, (identifier, transform) => {
		const carrier = takeFitting(rng, carriers, Carrier.literals, (value) =>
			isRealistic({ identifier, transform, carrier: value }),
		);

		const entry = takeFitting(rng, entries, Entry.literals, (value) =>
			isRealistic({ identifier, transform, carrier, entry: value }),
		);

		return { identifier, carrier, transform, entry };
	});

	return rng.shuffle(plans);
};
