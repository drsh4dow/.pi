import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import type { SafeHarbor } from "../policy/index.ts";
import { compactJson } from "./encodings.ts";
import { healthLabels, identifierLabels } from "./labels.ts";
import type { Random } from "./random.ts";
import { type Field, primaryOf, type RenderInput, systemTime } from "./record.ts";

const segment = (name: string, fields: Readonly<Record<number, string>>) => {
	const last = Math.max(...Arr.map(Rec.keys(fields), Number));

	return Arr.join([name, ...Arr.makeBy(last, (index) => fields[index + 1] ?? "")], "|");
};

const states: Arr.NonEmptyReadonlyArray<string> = ["OR", "WA", "TX", "FL", "AZ", "NM", "CA"];

type PidPlace = (value: string, state: string) => Readonly<Record<number, string>>;

const pidFields: Partial<Record<SafeHarbor, PidPlace>> = {
	name: (value) => ({ 5: value }),
	geographic: (value, state) => ({
		11: /^\d{5}-\d{4}$/u.test(value) ? `^^^${state}^${value}` : `${value}^^^${state}`,
	}),
	date: (value) => ({ 7: value }),
	phone: (value) => ({ 13: `${value}^PRN^PH` }),
	fax: (value) => ({ 13: `${value}^PRN^FX` }),
	email: (value) => ({ 13: `^NET^Internet^${value}` }),
	url: (value) => ({ 13: `^NET^Internet^${value}` }),
	mrn: (value) => ({ 3: `${value}^^^NFH^MR` }),
	account: (value) => ({ 18: `${value}^^^NFH^AN` }),
	ssn: (value) => ({ 19: value }),
	license: (value, state) => ({ 20: `${value}^${state}` }),
};

const extraSegments = (kind: SafeHarbor, value: string, label: string) => {
	const observation = (type: string, code: string, observed: string) =>
		segment("OBX", { 1: "1", 2: type, 3: code, 5: observed, 11: "F" });

	const extras: Partial<Record<SafeHarbor, ReadonlyArray<string>>> = {
		"health-plan": [segment("IN1", { 1: "1", 2: "CMHP01", 3: "60054", 4: "CASCADE MUTUAL HEALTH PLAN", 36: value })],
		vehicle: [observation("ST", `VIN^${label}^L`, value)],
		device: [observation("ST", `DEVSN^${label}^L`, value)],
		biometric: [observation("ED", `FPT^${label}^L`, `^AP^Octet-stream^Base64^${value}`)],
		photo: [observation("RP", `72170-4^${label}^LN`, `${value}^IMAGE^PNG`)],
		ip: [segment("NTE", { 1: "1", 3: `${label}: ${value}` })],
	};

	return extras[kind] ?? [];
};

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
		segments: Str.startsWith("OMP")(type) ? [msh] : [msh, segment("EVN", { 1: Str.slice(4, 7)(type), 2: stamp })],
	};
};

const pidSegment = (field: Field, rng: Random) =>
	segment("PID", { 1: "1", 8: rng.pick(["F", "M"]), ...pidFields[field.kind]?.(field.value, rng.pick(states)) });

/** An HL7 v2.5.1 ADT message, or a pharmacy order when the identifier is a prescription number. */
export const hl7v2 = ({ record, rng, minified }: RenderInput) => {
	const { lang, diagnosis } = record;
	const field = primaryOf(record);
	const isOrder = field.kind === "other-id";
	const type = isOrder ? "OMP^O09^OMP_O09" : rng.pick(["ADT^A01^ADT_A01", "ADT^A04^ADT_A01", "ADT^A08^ADT_A01"]);
	const { controlId, segments: head } = header(rng, type);
	const medication = diagnosis.medication[lang];

	const treatment = isOrder
		? [segment("ORC", { 1: "NW", 2: field.value }), segment("RXO", { 1: `^${medication}^L` })]
		: [segment("NTE", { 1: "1", 3: `${healthLabels.medication[lang]}: ${medication}` })];

	const segments = [
		...head,
		pidSegment(field, rng),
		segment("PV1", {
			1: "1",
			2: rng.pick(["O", "I", "E"]),
			3: `${rng.pick(["CARD", "ENDO", "ONC", "PSY", "NEPH"])}^^^NFH`,
		}),
		...extraSegments(field.kind, field.value, identifierLabels[field.kind][lang]),
		...treatment,
		segment("DG1", { 1: "1", 3: `${diagnosis.code}^${diagnosis.text[lang]}^I10`, 6: "A" }),
	];

	return minified
		? compactJson({ channel: "ADT_INBOUND", messageControlId: controlId, raw: Arr.join(segments, "\r") })
		: Arr.join(segments, "\n");
};
