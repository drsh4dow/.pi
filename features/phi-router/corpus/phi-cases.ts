import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { SafeHarbor } from "../policy/index.ts";
import { carriers } from "./carriers.ts";
import { converse } from "./conversation.ts";
import { bury } from "./filler.ts";
import { diagnoses } from "./health.ts";
import { type DrawContext, drawIdentifier, drawServiceDate } from "./identifiers.ts";
import type { PhiCase, PhiStrata } from "./manifest.ts";
import { foreignLangs } from "./people.ts";
import type { Random } from "./random.ts";
import { type Field, type PhiRecord, primaryOf, topicOf } from "./record.ts";
import { asBase64, asGzipHex, splitPayload, withTypos } from "./transforms.ts";
import { x12Requires } from "./x12.ts";

const unique = (used: Set<string>, draw: () => string) => {
	let value = draw();

	while (used.has(value)) {
		value = draw();
	}

	used.add(value);

	return value;
};

const fieldsOf = (strata: PhiStrata, context: DrawContext, used: Set<string>): Arr.NonEmptyReadonlyArray<Field> => {
	const field = (kind: SafeHarbor): Field => ({ kind, value: unique(used, () => drawIdentifier(kind)(context)) });

	if (strata.carrier !== "x12-837") {
		return [field(strata.identifier)];
	}

	const extras = Arr.filter(x12Requires, (kind) => kind !== strata.identifier);
	const serviceDate: Field = { kind: "date", value: unique(used, () => drawServiceDate(context.rng)) };

	return [field(strata.identifier), ...Arr.map(extras, field), serviceDate];
};

interface PhiCaseRequest {
	readonly id: string;
	readonly strata: PhiStrata;
	readonly rng: Random;
	readonly used: Set<string>;
}

const buriedSize = 600_000;

const partsOf = (request: PhiCaseRequest, record: PhiRecord) => {
	const { strata, rng } = request;
	const spec = carriers[strata.carrier];
	const payload = spec.render({ record, rng, minified: strata.transform === "minified" });
	const canaries = Arr.map(record.fields, ({ value }) => value);
	const { code } = record.diagnosis;
	const markers = [code, Str.replaceAll(".", "")(code), topicOf(record)];
	const cut = strata.entry === "compaction-summary" || rng.chance(0.5) ? "apart-from-marker" : "through-identifier";

	const byTransform = {
		plain: () => [payload] as const,
		minified: () => [payload] as const,
		"non-english": () => [payload] as const,
		buried: () => [bury({ rng, carrier: strata.carrier, size: buriedSize })(payload)] as const,
		typos: () => [withTypos({ rng, canaries })(payload)] as const,
		base64: () => [asBase64({ rng, mimeType: spec.mimeType })(payload)] as const,
		"gzip-hex": () => [asGzipHex(rng)(payload)] as const,
		split: () => splitPayload({ payload, canary: primaryOf(record).value, markers, cut }),
	};

	return byTransform[strata.transform]();
};

export const phiCase = (request: PhiCaseRequest): typeof PhiCase.Type => {
	const { id, strata, rng, used } = request;
	const lang = strata.transform === "non-english" ? rng.pick(foreignLangs) : "en";
	const fields = fieldsOf(strata, { rng, lang, carrier: strata.carrier }, used);
	const record: PhiRecord = { lang, fields, diagnosis: rng.pick(diagnoses), rowId: rng.between(1000, 99_999) };
	const parts = partsOf(request, record);

	const messages = converse({
		entry: strata.entry,
		scene: carriers[strata.carrier],
		parts,
		image: strata.carrier === "screenshot" || strata.identifier === "photo",
		rng,
	});

	return { id, expect: "phi", strata, canaries: Arr.map(fields, ({ value }) => value), messages };
};
