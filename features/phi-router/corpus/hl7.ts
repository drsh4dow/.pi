import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { compactJson } from "./encodings.ts";
import { healthLabels } from "./labels.ts";
import type { TextIdentifier } from "./manifest.ts";
import type { Random } from "./random.ts";
import { type Field, type PhiRecord, type RenderInput, systemTime } from "./record.ts";

const segment = (name: string, fields: Readonly<Record<number, string>>) => {
	const last = Math.max(...Arr.map(Rec.keys(fields), Number));

	return Arr.join([name, ...Arr.makeBy(last, (index) => fields[index + 1] ?? "")], "|");
};

const states: Arr.NonEmptyReadonlyArray<string> = ["OR", "WA", "TX", "FL", "AZ", "NM", "CA"];

type PidPlace = (value: string, state: string) => Readonly<Record<number, string>>;

/** Where PID carries each identifier. PID-3 holds the internal patient id unless an outside identifier takes it. */
const pidFields: Partial<Record<TextIdentifier, PidPlace>> = {
	"patient-name": (value) => ({ 5: value }),
	"street-address": (value, state) => ({ 11: `${value}^^^${state}` }),
	"birth-date": (value) => ({ 7: value }),
	"personal-phone": (value) => ({ 13: `${value}^PRN^PH` }),
	"personal-email": (value) => ({ 13: `^NET^Internet^${value}` }),
	mrn: (value) => ({ 3: `${value}^^^NFH^MR` }),
	"medicare-medicaid-number": (value) => ({ 3: `${value}^^^CMS^MC` }),
	passport: (value) => ({ 3: `${value}^^^USA^PPN` }),
	ssn: (value) => ({ 19: value }),
	"driver-license": (value, state) => ({ 20: `${value}^${state}` }),
};

const insurance = (fields: ReadonlyArray<Field>) =>
	Arr.flatMap(fields, ({ kind, value }) =>
		kind === "member-number"
			? [segment("IN1", { 1: "1", 2: "CMHP01", 3: "60054", 4: "CASCADE MUTUAL HEALTH PLAN", 36: value })]
			: [],
	);

const header = (rng: Random, type: string) => {
	const stamp = Str.slice(0, 12)(Str.replaceAll(/\D/gu, "")(systemTime(rng)));
	const controlId = `MSG${rng.digits(8)}`;

	const msh = segment("MSH", {
		1: String.raw`^~\&`,
		2: rng.pick(["EPICADT", "CERNER", "MEDITECH"]),
		3: "NFH",
		4: "INTEGRATION",
		5: "ETL",
		6: stamp,
		8: type,
		9: controlId,
		10: "P",
		11: "2.5.1",
	});

	return {
		controlId,
		segments: [msh, segment("EVN", { 1: Str.slice(4, 7)(type), 2: stamp })],
	};
};

const pidSegment = ({ fields, rowId }: PhiRecord, rng: Random) => {
	const state = rng.pick(states);
	const placed = Arr.flatMap(fields, ({ kind, value }) => Rec.toEntries(pidFields[kind]?.(value, state) ?? {}));

	return segment("PID", {
		1: "1",
		3: `${String(rowId)}^^^NFH^PI`,
		8: rng.pick(["F", "M"]),
		...Rec.fromEntries(placed),
	});
};

export const hl7v2 = ({ record, rng, minified }: RenderInput) => {
	const { lang, diagnosis } = record;
	const type = rng.pick(["ADT^A01^ADT_A01", "ADT^A04^ADT_A01", "ADT^A08^ADT_A01"]);
	const { controlId, segments: head } = header(rng, type);

	const segments = [
		...head,
		pidSegment(record, rng),
		segment("PV1", {
			1: "1",
			2: rng.pick(["O", "I", "E"]),
			3: `${rng.pick(["CARD", "ENDO", "ONC", "PSY", "NEPH"])}^^^NFH`,
		}),
		...insurance(record.fields),
		segment("NTE", { 1: "1", 3: `${healthLabels.medication[lang]}: ${diagnosis.medication[lang]}` }),
		segment("DG1", { 1: "1", 3: `${diagnosis.code}^${diagnosis.text[lang]}^I10`, 6: "A" }),
	];

	return minified
		? compactJson({ channel: "ADT_INBOUND", messageControlId: controlId, raw: Arr.join(segments, "\r") })
		: Arr.join(segments, "\n");
};
