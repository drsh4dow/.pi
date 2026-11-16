import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { carriers } from "./carriers.ts";
import { converse } from "./conversation.ts";
import { bury } from "./filler.ts";
import { diagnoses } from "./health.ts";
import { type DrawContext, drawIdentifier } from "./identifiers.ts";
import type { PhiCase, TextIdentifier } from "./manifest.ts";
import { foreignLangs } from "./people.ts";
import type { TextStrata } from "./plan.ts";
import { type Random, unique } from "./random.ts";
import type { Field, PhiRecord } from "./record.ts";
import { asBase64, asGzipHex, splitPayload, withTypos } from "./transforms.ts";
import { x12Requires } from "./x12.ts";

/** Identifiers the case needs beside its stratum's: a birth date is planted with its owner's name. */
const companionsOf = ({ identifier, carrier }: TextStrata) => {
	const needed: ReadonlyArray<TextIdentifier> = [
		...(identifier === "birth-date" ? ["patient-name" as const] : []),
		...(carrier === "x12-837" ? x12Requires : []),
	];

	return Arr.filter(Arr.dedupe(needed), (kind) => kind !== identifier);
};

const fieldsOf = (strata: TextStrata, context: DrawContext, used: Set<string>): Arr.NonEmptyReadonlyArray<Field> => {
	const field = (kind: TextIdentifier): Field => ({
		kind,
		value: unique({ used, draw: () => drawIdentifier(kind)(context) }),
	});

	return [field(strata.identifier), ...Arr.map(companionsOf(strata), field)];
};

interface PhiCaseRequest {
	readonly strata: TextStrata;
	readonly rng: Random;
	readonly used: Set<string>;
}

const buriedSize = 600_000;

const whole = (text: string): Delivered => ({ parts: [text], canaryParts: Option.none() });

interface Delivered {
	readonly parts: readonly [string] | readonly [string, string];
	readonly canaryParts: Option.Option<Readonly<Record<string, readonly [string, string]>>>;
}

const deliver = (request: PhiCaseRequest, record: PhiRecord, canaries: Arr.NonEmptyReadonlyArray<string>) => {
	const { strata, rng } = request;
	const spec = carriers[strata.carrier];
	const payload = spec.render({ record, rng, minified: strata.transform === "minified" });

	const byTransform = {
		plain: () => whole(payload),
		minified: () => whole(payload),
		"non-english": () => whole(payload),
		buried: () => whole(bury({ rng, carrier: strata.carrier, size: buriedSize })(payload)),
		typos: () => whole(withTypos({ rng, canaries })(payload)),
		base64: () => whole(asBase64({ rng, mimeType: spec.mimeType })(payload)),
		"gzip-hex": () => whole(asGzipHex(rng)(payload)),
		split: (): Delivered => {
			const canary = Arr.headNonEmpty(canaries);
			const { halves, parts } = splitPayload({ payload, canary });

			return { parts: halves, canaryParts: Option.some({ [canary]: parts }) };
		},
	} satisfies Record<TextStrata["transform"], () => Delivered>;

	return byTransform[strata.transform]();
};

export const phiCase = (request: PhiCaseRequest): Omit<typeof PhiCase.Type, "id"> => {
	const { strata, rng, used } = request;
	const lang = strata.transform === "non-english" ? rng.pick(foreignLangs) : "en";
	const fields = fieldsOf(strata, { rng, lang, carrier: strata.carrier }, used);
	const canaries = Arr.map(fields, ({ value }) => value);
	const record: PhiRecord = { lang, fields, diagnosis: rng.pick(diagnoses), rowId: rng.between(1000, 99_999) };
	const { parts, canaryParts } = deliver(request, record, canaries);

	const messages = converse({
		entry: strata.entry,
		scene: carriers[strata.carrier],
		parts,
		image: Option.none(),
		quotes: canaries,
		rng,
	});

	const planted = { expect: "phi", strata, canaries, fragments: [], messages } as const;

	return Option.match(canaryParts, {
		onNone: () => planted,
		onSome: (cut) => ({ ...planted, canaryParts: cut }),
	});
};
