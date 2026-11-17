import * as Arr from "effect/Array";

import { carriers } from "./carriers.ts";
import type { Sample } from "./conversation.ts";
import { diagnoses } from "./health.ts";
import { nameIn } from "./identifiers.ts";
import { type Synthetic, TextCarrier } from "./manifest.ts";
import type { PersonName } from "./people.ts";
import type { Random } from "./random.ts";

/** The QA test members of this corpus. Their identities are on the exact list, so a case holding only them is clean. */
const personas: Arr.NonEmptyReadonlyArray<{ readonly name: PersonName; readonly member: string }> = [
	{ name: { given: "Quinlan", family: "Testmember", lang: "en" }, member: "ZQA900000417" },
	{ name: { given: "Avery", family: "Fixtureson", lang: "en" }, member: "ZQA900000522" },
	{ name: { given: "Morgan", family: "Stagingly", lang: "en" }, member: "ZQA900000638" },
];

const clientCodePrefix = "STGQA-";

export const synthetic: Synthetic = {
	exact: Arr.dedupe(
		Arr.flatMap(personas, ({ name, member }) => [
			...Arr.map(TextCarrier.literals, (carrier) => nameIn(carrier)(name)),
			member,
		]),
	),
	prefixes: [clientCodePrefix],
};

const recordSample =
	(carrier: TextCarrier) =>
	(rng: Random): Sample => {
		const { name, member } = rng.pick(personas);

		const record = {
			lang: "en",
			fields: [
				{ kind: "patient-name", value: nameIn(carrier)(name) },
				{ kind: "member-number", value: member },
			],
			diagnosis: rng.pick(diagnoses),
			rowId: rng.between(1000, 99_999),
		} as const;

		return { scene: carriers[carrier], payload: carriers[carrier].render({ record, rng, minified: false }) };
	};

const stagingLog = (rng: Random): Sample => {
	const lines = Arr.makeBy(rng.between(3, 5), () => {
		const { member } = rng.pick(personas);
		const client = `${clientCodePrefix}${rng.digits(4)}`;

		return `2025-03-0${String(rng.between(1, 9))}T0${String(rng.between(0, 9))}:${String(rng.between(10, 59))}:00Z staging eligibility client=${client} member=${member} result=${rng.pick(["active", "inactive", "timeout"])}`;
	});

	return {
		scene: {
			asks: ["Staging eligibility checks time out for our QA members. What's different about them?"],
			commands: ["kubectl -n staging logs deploy/eligibility --since=1h | grep member="],
			paths: ["logs/staging-eligibility.log"],
		},
		payload: Arr.join(lines, "\n"),
	};
};

export const syntheticListed: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	stagingLog,
	...Arr.map(TextCarrier.literals, recordSample),
];
