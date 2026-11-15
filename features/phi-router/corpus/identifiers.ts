import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { SafeHarbor } from "../policy/index.ts";
import type { Carrier } from "./manifest.ts";
import { ascii, drawName, fullName, type Lang } from "./people.ts";
import type { Random } from "./random.ts";
import { two } from "./record.ts";

export interface DrawContext {
	readonly rng: Random;
	readonly lang: Lang;
	readonly carrier: typeof Carrier.Type;
}

const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
const alphanumerics = `${letters}0123456789`;

const nameValue = ({ rng, lang, carrier }: DrawContext) => {
	const name = drawName(lang)(rng);

	if (carrier === "hl7v2") {
		return `${name.family}^${name.given}`;
	}

	if (carrier === "x12-837") {
		return Str.toUpperCase(`${ascii(name.family)}*${ascii(name.given)}`);
	}

	return carrier === "file-name" ? `${name.family}, ${name.given}` : fullName(name);
};

const streetValue = ({ rng, lang }: DrawContext) => {
	const street = drawName(lang)(rng);
	const number = rng.between(12, 9890);

	const forms = {
		en: `${String(number)} ${street.family} ${rng.pick(["Ave", "St", "Rd", "Ln", "Ct", "Dr"])}`,
		es: `Calle ${street.family} ${String(number)}`,
		de: `${street.family}straße ${String(1 + (number % 200))}`,
		fr: `${String(1 + (number % 300))} rue ${street.family}`,
		pt: `Rua ${street.family}, ${String(number)}`,
		vi: `${String(1 + (number % 500))} đường ${fullName(street)}`,
	};

	return forms[lang];
};

const geographicValue = (context: DrawContext) =>
	context.rng.chance(0.25) ? `${context.rng.digits(5)}-${context.rng.digits(4)}` : streetValue(context);

const dateValue = ({ rng, lang, carrier }: DrawContext) => {
	const [year, month, day] = [String(rng.between(1934, 2006)), two(rng.between(1, 12)), two(rng.between(1, 28))];

	if (carrier === "hl7v2" || carrier === "x12-837") {
		return `${year}${month}${day}`;
	}

	if (carrier === "fhir-json" || carrier === "file-name" || (lang === "en" && rng.chance(0.4))) {
		return `${year}-${month}-${day}`;
	}

	if (lang === "en") {
		return `${month}/${day}/${year}`;
	}

	return lang === "de" ? `${day}.${month}.${year}` : `${day}/${month}/${year}`;
};

/** A date of service in 2022 to 2024, as the 837's DTP segment writes it. */
export const drawServiceDate = (rng: Random) =>
	`${String(rng.between(2022, 2024))}${two(rng.between(1, 12))}${two(rng.between(1, 28))}`;

const areaCodes: Arr.NonEmptyReadonlyArray<string> = ["503", "971", "614", "412", "720", "919", "602", "786", "347"];

const phoneValue = ({ rng, lang, carrier }: DrawContext) => {
	const area = rng.pick(areaCodes);
	const exchange = `${String(rng.between(2, 9))}${rng.pick(["1", "2", "3", "4", "6", "7", "8", "9"])}${rng.digits(1)}`;
	const line = rng.digits(4);

	if (carrier === "x12-837" || carrier === "file-name") {
		return `${area}${exchange}${line}`;
	}

	if (carrier === "hl7v2") {
		return `(${area})${exchange}-${line}`;
	}

	return lang === "en"
		? rng.pick([`(${area}) ${exchange}-${line}`, `${area}-${exchange}-${line}`])
		: `+1 ${area} ${exchange} ${line}`;
};

const emailValue = ({ rng, lang }: DrawContext) => {
	const name = drawName(lang)(rng);
	const local = Str.toLowerCase(ascii(`${name.given}${rng.pick([".", "_", ""])}${name.family}`));
	const domain = rng.pick(["mail.example.org", "post.example.net", "fernpost.example", "quillmail.example"]);

	return `${Str.replaceAll(" ", "")(local)}${rng.digits(2)}@${domain}`;
};

/** Areas 900 to 999 and 666 were never issued. */
const ssnValue = ({ rng, carrier }: DrawContext) => {
	const area = rng.chance(0.15) ? "666" : String(rng.between(900, 999));
	const [group, serial] = [two(rng.between(1, 99)), Str.padStart(4, "0")(String(rng.between(1, 9999)))];

	return carrier === "x12-837" ? `${area}${group}${serial}` : `${area}-${group}-${serial}`;
};

/** A Medicare Beneficiary Identifier, which skips S, L, O, I, B and Z. */
const mbiValue = (rng: Random) => {
	const alpha = "ACDEFGHJKMNPQRTUVWXY";
	const alnum = `${alpha}0123456789`;

	return `${String(rng.between(1, 9))}${rng.chars(alpha, 1)}${rng.chars(alnum, 1)}${rng.digits(1)}${rng.chars(alpha, 1)}${rng.chars(alnum, 1)}${rng.digits(1)}${rng.chars(alpha, 2)}${rng.digits(2)}`;
};

const vinWeights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** The VIN transliteration table: a letter's value is its index here, mod 10. */
const vinLetters = ".ABCDEFGH..JKLMN.P.R..STUVWXYZ";

const vinValue = (char: string) =>
	Option.getOrElse(
		Str.indexOf(char)("0123456789"),
		() => Option.getOrElse(Str.indexOf(char)(vinLetters), () => 0) % 10,
	);

/** A VIN with a valid check digit in position 9. */
const vehicleValue = ({ rng }: DrawContext) => {
	const draft = `${rng.pick(["1HG", "2T1", "3FA", "5YJ", "JTD", "KMH", "WVW"])}${rng.chars(alphanumerics, 5)}0${rng.chars("LMNPRS", 1)}${rng.chars(alphanumerics, 1)}${rng.digits(6)}`;

	const sum = Arr.reduce(
		Arr.fromIterable(draft),
		0,
		(total, char, index) => total + vinValue(char) * (vinWeights[index] ?? 0),
	);

	const check = sum % 11 === 10 ? "X" : String(sum % 11);

	return `${Str.slice(0, 8)(draft)}${check}${Str.slice(9)(draft)}`;
};

const draws = {
	name: nameValue,
	geographic: geographicValue,
	date: dateValue,
	phone: phoneValue,
	fax: phoneValue,
	email: emailValue,
	ssn: ssnValue,
	mrn: ({ rng }) =>
		rng.pick([`E${rng.digits(7)}`, `${String(rng.between(1, 9))}${rng.digits(8)}`, `MR${rng.digits(8)}`]),
	"health-plan": ({ rng }) => (rng.chance(0.4) ? mbiValue(rng) : `${rng.chars(letters, 3)}${rng.digits(9)}`),
	account: ({ rng }) => rng.pick([rng.digits(10), `PA${rng.digits(8)}`, `HAR${rng.digits(9)}`]),
	license: ({ rng }) =>
		rng.pick([
			`${rng.chars(letters, 1)}${rng.digits(7)}`,
			`WDL${rng.chars(alphanumerics, 9)}`,
			`${rng.digits(3)} ${rng.digits(3)} ${rng.digits(3)}`,
			`${rng.chars(letters, 1)}${rng.digits(3)}-${rng.digits(3)}-${rng.digits(2)}-${rng.digits(3)}-${rng.digits(1)}`,
		]),
	vehicle: vehicleValue,
	device: ({ rng }) =>
		rng.pick([
			`${rng.chars(letters, 3)}${rng.digits(6)}${rng.chars(letters, 1)}`,
			`NG${rng.digits(7)}${rng.chars(letters, 1)}`,
			`SM${rng.chars(alphanumerics, 8)}`,
		]),
	url: ({ rng }) =>
		rng.pick([
			`https://portal.northfield-health.example/patients/${rng.digits(7)}/chart`,
			`https://mychart.example.org/share/${rng.chars(alphanumerics, 10)}`,
			`https://records.example.net/r/${rng.hex(12)}`,
		]),
	ip: ({ rng }) =>
		rng.pick([
			`192.0.2.${String(rng.between(1, 254))}`,
			`198.51.100.${String(rng.between(1, 254))}`,
			`203.0.113.${String(rng.between(1, 254))}`,
			`10.${String(rng.between(0, 255))}.${String(rng.between(0, 255))}.${String(rng.between(1, 254))}`,
		]),
	/** ISO 19794-2 templates start with "FMR\0 20\0", which base64 writes as `Rk1SACAyMAA`. */
	biometric: ({ rng }) =>
		`Rk1SACAyMAA${rng.chars("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", 41)}=`,
	photo: ({ rng }) =>
		rng.pick([
			`intake-photo-${rng.chars(alphanumerics, 8)}.png`,
			`face_${rng.hex(10)}.png`,
			`IMG_${rng.digits(4)}${rng.chars(letters, 3)}.png`,
		]),
	"other-id": ({ rng }) => rng.pick([`RX${rng.digits(7)}`, `${rng.digits(7)}-${rng.digits(2)}`]),
} satisfies Record<SafeHarbor, (context: DrawContext) => string>;

export const drawIdentifier = (kind: SafeHarbor) => draws[kind];
