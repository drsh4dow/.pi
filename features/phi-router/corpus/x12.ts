import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { SafeHarbor } from "../policy/index.ts";
import { identifierLabels } from "./labels.ts";
import { ascii } from "./people.ts";
import { primaryOf, type RenderInput, systemTime, valueOf } from "./record.ts";

/**
 * Identifiers an 837P cannot leave out: subscriber name, member id and patient control number, which the subscriber's
 * NM1 and the CLM segment carry. It also needs a service date.
 */
export const x12Requires: ReadonlyArray<SafeHarbor> = ["name", "health-plan", "account"];

/** A valid NPI: Luhn over the `80840` prefix and the first nine digits. */
const npi = (nine: string) => {
	const digits = Arr.map(Arr.fromIterable(`80840${nine}`), Number);

	const sum = Arr.reduce(Arr.reverse(digits), 0, (total, digit, index) => {
		const doubled = index % 2 === 0 ? digit * 2 : digit;

		return total + (doubled > 9 ? doubled - 9 : doubled);
	});

	return `${nine}${String((10 - (sum % 10)) % 10)}`;
};

type Place = (value: string, label: string) => string;

/** Segments of the subscriber loop, 2010BA, that carry the stratum's identifier. */
const subscriberLoop: Partial<Record<SafeHarbor, Place>> = {
	date: (value) => `DMG*D8*${value}*F`,
	ssn: (value) => `REF*SY*${value}`,
};

/** Segments of the claim loop, 2300, that carry the stratum's identifier: a native one, else a claim note. */
const claimLoop: Partial<Record<SafeHarbor, Place>> = {
	mrn: (value) => `REF*EA*${value}`,
	photo: (value) => `PWK*OZ*EL***AC*${value}`,
};

const claimNote: Place = (value, label) => `NTE*ADD*${Str.toUpperCase(ascii(label))} ${value}`;

const transactionOf = ({ record, rng }: RenderInput, envelope: Envelope) => {
	const field = primaryOf(record);
	const label = identifierLabels[field.kind][record.lang];
	const required = (kind: SafeHarbor) => Option.getOrElse(valueOf(kind)(record), () => "");
	const serviceDate = Arr.findLast(record.fields, ({ kind }) => kind === "date");
	const subscriberPlace = subscriberLoop[field.kind];
	const inClaim = subscriberPlace === undefined && !Arr.contains(x12Requires, field.kind);
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
		`NM1*IL*1*${required("name")}****MI*${required("health-plan")}`,
		...(subscriberPlace === undefined ? [] : [subscriberPlace(field.value, label)]),
		"NM1*PR*2*CASCADE MUTUAL HEALTH PLAN*****PI*60054",
		`CLM*${required("account")}*${charge}***11:B:1*Y*A*Y*Y`,
		...(inClaim ? [(claimLoop[field.kind] ?? claimNote)(field.value, label)] : []),
		`HI*ABK:${Str.replaceAll(".", "")(record.diagnosis.code)}`,
		"LX*1",
		`SV1*HC:${rng.pick(["99213", "99214", "99203", "93000", "80053"])}*${charge}*UN*1***1`,
		`DTP*472*D8*${Option.match(serviceDate, { onNone: () => "", onSome: ({ value }) => value })}`,
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
