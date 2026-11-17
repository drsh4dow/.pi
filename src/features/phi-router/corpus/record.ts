import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import type { Diagnosis } from "./health.ts";
import { healthLabels, identifierLabels } from "./labels.ts";
import type { TextIdentifier } from "./manifest.ts";
import { type Lang, slug } from "./people.ts";
import type { Random } from "./random.ts";

export interface Field {
	readonly kind: TextIdentifier;
	readonly value: string;
}

export interface PhiRecord {
	readonly lang: Lang;
	/**
	 * The direct identifiers it holds: the stratum's first, then any the case or the carrier's format cannot leave out.
	 * None for a record keyed only by its internal id.
	 */
	readonly fields: ReadonlyArray<Field>;
	readonly diagnosis: Diagnosis;
	/** The internal patient id, which identifies nobody outside the system. */
	readonly rowId: number;
}

export interface RenderInput {
	readonly record: PhiRecord;
	readonly rng: Random;
	readonly minified: boolean;
}

export interface Labelled {
	/** The label as a snake_case column or key name. */
	readonly key: string;
	readonly label: string;
	readonly value: string;
}

const labelled = (label: string, value: string): Labelled => ({ key: slug("_")(label), label, value });

export const labelledValues = ({ lang, fields, diagnosis, rowId }: PhiRecord) => [
	{ key: "patient_id", label: "patient_id", value: String(rowId) },
	...Arr.map(fields, (field) => labelled(identifierLabels[field.kind][lang], field.value)),
	labelled(healthLabels.code[lang], diagnosis.code),
	labelled(healthLabels.diagnosis[lang], diagnosis.text[lang]),
	labelled(healthLabels.medication[lang], diagnosis.medication[lang]),
];

export const recordObject = (values: ReadonlyArray<Labelled>) =>
	Rec.fromEntries(Arr.map(values, ({ key, value }) => [key, value]));

export const topicOf = ({ diagnosis, lang }: PhiRecord) => {
	const words = Str.split("-")(slug("-")(diagnosis.text[lang]));

	return Arr.join(Arr.take(words, 4), "-");
};

export const valueOf = (kind: TextIdentifier) => (record: PhiRecord) =>
	Option.map(
		Arr.findFirst(record.fields, (field) => field.kind === kind),
		(field) => field.value,
	);

export const uuid = (rng: Random) =>
	`${rng.hex(8)}-${rng.hex(4)}-4${rng.hex(3)}-${rng.pick(["8", "9", "a", "b"])}${rng.hex(3)}-${rng.hex(12)}`;

export const two = (value: number) => Str.padStart(2, "0")(String(value));

export const systemTime = (rng: Random) =>
	`2025-${two(rng.between(1, 12))}-${two(rng.between(1, 28))}T${two(rng.between(0, 23))}:${two(rng.between(0, 59))}:${two(rng.between(0, 59))}.${rng.digits(3)}Z`;
