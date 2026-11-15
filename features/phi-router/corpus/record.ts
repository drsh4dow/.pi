import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import type { SafeHarbor } from "../policy/index.ts";
import type { Diagnosis } from "./health.ts";
import { healthLabels, identifierLabels } from "./labels.ts";
import { type Lang, slug } from "./people.ts";
import type { Random } from "./random.ts";

export interface Field {
	readonly kind: SafeHarbor;
	readonly value: string;
}

export interface PhiRecord {
	readonly lang: Lang;
	/** The stratum's identifier first, then any identifier the carrier's format cannot leave out. */
	readonly fields: Arr.NonEmptyReadonlyArray<Field>;
	readonly diagnosis: Diagnosis;
	/** A surrogate row key, which identifies nobody. */
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

export const labelledValues = ({ lang, fields, diagnosis }: PhiRecord) => [
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

export const primaryOf = (record: PhiRecord) => Arr.headNonEmpty(record.fields);

export const valueOf = (kind: SafeHarbor) => (record: PhiRecord) =>
	Option.map(
		Arr.findFirst(record.fields, (field) => field.kind === kind),
		(field) => field.value,
	);

export const uuid = (rng: Random) =>
	`${rng.hex(8)}-${rng.hex(4)}-4${rng.hex(3)}-${rng.pick(["8", "9", "a", "b"])}${rng.hex(3)}-${rng.hex(12)}`;

export const two = (value: number) => Str.padStart(2, "0")(String(value));

export const systemTime = (rng: Random) =>
	`2025-${two(rng.between(1, 12))}-${two(rng.between(1, 28))}T${two(rng.between(0, 23))}:${two(rng.between(0, 59))}:${two(rng.between(0, 59))}.${rng.digits(3)}Z`;
