import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { identifierLabels } from "./labels.ts";
import type { TextIdentifier } from "./manifest.ts";
import { ascii } from "./people.ts";
import type { Random } from "./random.ts";
import { type Field, type RenderInput, systemTime, two, valueOf } from "./record.ts";

/** Identifiers an 837P cannot leave out: the subscriber's name and member id, which the subscriber's NM1 carries. */
export const x12Requires: ReadonlyArray<TextIdentifier> = ["patient-name", "member-number"];

/** A valid NPI: Luhn over the `80840` prefix and the first nine digits. */
const npi = (nine: string) => {
	const digits = Arr.map(Arr.fromIterable(`80840${nine}`), Number);

	const sum = Arr.reduce(Arr.reverse(digits), 0, (total, digit, index) => {
		const doubled = index % 2 === 0 ? digit * 2 : digit;

		return total + (doubled > 9 ? doubled - 9 : doubled);
	});

	return `${nine}${String((10 - (sum % 10)) % 10)}`;
};

const drawServiceDate = (rng: Random) =>
	`${String(rng.between(2022, 2024))}${two(rng.between(1, 12))}${two(rng.between(1, 28))}`;

type Place = (value: string, label: string) => string;

/** Segments of the subscriber loop, 2010BA, that carry an identifier. */
const subscriberLoop: Partial<Record<TextIdentifier, Place>> = {
	"birth-date": (value) => `DMG*D8*${value}*F`,
	"street-address": (value) => `N3*${value}`,
	ssn: (value) => `REF*SY*${value}`,
};

/** Segments of the claim loop, 2300, that carry an identifier: a native one, else a claim note. */
const claimLoop: Partial<Record<TextIdentifier, Place>> = {
	mrn: (value) => `REF*EA*${value}`,
};

const claimNote: Place = (value, label) => `NTE*ADD*${Str.toUpperCase(ascii(label))} ${value}`;

const transactionOf = ({ record, rng }: RenderInput, envelope: Envelope) => {
	const required = (kind: TextIdentifier) => Option.getOrElse(valueOf(kind)(record), () => "");
	const others = Arr.filter(record.fields, ({ kind }) => !Arr.contains(x12Requires, kind));
	const label = ({ kind }: Field) => identifierLabels[kind][record.lang];

	const subscriber = Arr.flatMap(others, (field) => {
		const place = subscriberLoop[field.kind];

		return place === undefined ? [] : [place(field.value, label(field))];
	});

	const claim = Arr.flatMap(others, (field) =>
		subscriberLoop[field.kind] === undefined ? [(claimLoop[field.kind] ?? claimNote)(field.value, label(field))] : [],
	);

	const charge = `${String(rng.between(85, 420))}.00`;

	return [
		"ST*837*0001*005010X222A1",
		`BHT*0019*00*${rng.digits(6)}*${envelope.date}*${envelope.time}*CH`,
		`NM1*41*2*NORTHFIELD BILLING*****46*S${rng.digits(5)}`,
		"PER*IC*EDI DESK*EM*edi@northfield-health.example",
		`NM1*40*2*CLEARSTREAM EDI*****46*CSE${rng.digits(4)}`,
		"HL*1**20*1",
		`NM1*85*2*NORTHFIELD CLINIC*****XX*${npi(`1${rng.digits(8)}`)}`,
		"N3*200 RIVERFRONT PLAZA",
		"N4*PORTLAND*OR*972040000",
		`REF*EI*93${rng.digits(7)}`,
		"HL*2*1*22*0",
		"SBR*P*18*******CI",
		`NM1*IL*1*${required("patient-name")}****MI*${required("member-number")}`,
		...subscriber,
		"NM1*PR*2*CASCADE MUTUAL HEALTH PLAN*****PI*60054",
		`CLM*PCN${String(record.rowId)}*${charge}***11:B:1*Y*A*Y*Y`,
		...claim,
		`HI*ABK:${Str.replaceAll(".", "")(record.diagnosis.code)}`,
		"LX*1",
		`SV1*HC:${rng.pick(["99213", "99214", "99203", "93000", "80053"])}*${charge}*UN*1***1`,
		`DTP*472*D8*${drawServiceDate(rng)}`,
	];
};

interface Envelope {
	readonly date: string;
	readonly time: string;
	readonly control: string;
}

/** An 837 professional claim (005010X222A1) for one subscriber with one service line. */
export const x12837 = (input: RenderInput) => {
	const stamp = Str.replaceAll(/\D/gu, "")(systemTime(input.rng));
	const envelope = { date: Str.slice(0, 8)(stamp), time: Str.slice(8, 12)(stamp), control: input.rng.digits(9) };
	const transaction = transactionOf(input, envelope);

	const segments = [
		`ISA*00*          *00*          *ZZ*NORTHFIELD     *ZZ*CLEARSTREAM    *${Str.slice(2)(envelope.date)}*${envelope.time}*^*00501*${envelope.control}*0*P*:`,
		`GS*HC*NORTHFIELD*CLEARSTREAM*${envelope.date}*${envelope.time}*${String(input.rng.between(1, 9999))}*X*005010X222A1`,
		...transaction,
		`SE*${String(transaction.length + 1)}*0001`,
		`GE*1*${envelope.control}`,
		`IEA*1*${envelope.control}`,
	];

	return Arr.join(
		Arr.map(segments, (segment) => `${segment}~`),
		input.minified ? "" : "\n",
	);
};
