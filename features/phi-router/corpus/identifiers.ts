import type * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Carrier, TextIdentifier } from "./manifest.ts";
import { ascii, drawName, fullName, type Lang, type PersonName } from "./people.ts";
import type { Random } from "./random.ts";
import { two } from "./record.ts";

export interface DrawContext {
	readonly rng: Random;
	readonly lang: Lang;
	readonly carrier: typeof Carrier.Type;
}

const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
const alphanumerics = `${letters}0123456789`;

/** A person's name as the carrier's format writes it. */
export const nameIn = (carrier: typeof Carrier.Type) => (name: PersonName) => {
	if (carrier === "hl7v2") {
		return `${name.family}^${name.given}`;
	}

	if (carrier === "x12-837") {
		return Str.toUpperCase(`${ascii(name.family)}*${ascii(name.given)}`);
	}

	return carrier === "file-name" ? `${name.family}, ${name.given}` : fullName(name);
};

const nameValue = ({ rng, lang, carrier }: DrawContext) => nameIn(carrier)(drawName(lang)(rng));

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

const draws = {
	"patient-name": nameValue,
	ssn: ssnValue,
	"birth-date": dateValue,
	"street-address": streetValue,
	"personal-phone": phoneValue,
	"personal-email": emailValue,
	"member-number": ({ rng }) => `${rng.chars(letters, 3)}${rng.digits(9)}`,
	/** An MBI, or a Medicaid client id in New York's two letters, five digits and a letter. */
	"medicare-medicaid-number": ({ rng }) =>
		rng.chance(0.6) ? mbiValue(rng) : `${rng.chars(letters, 2)}${rng.digits(5)}${rng.chars(letters, 1)}`,
	mrn: ({ rng }) =>
		rng.pick([`E${rng.digits(7)}`, `${String(rng.between(1, 9))}${rng.digits(8)}`, `MR${rng.digits(8)}`]),
	"driver-license": ({ rng }) =>
		rng.pick([
			`${rng.chars(letters, 1)}${rng.digits(7)}`,
			`WDL${rng.chars(alphanumerics, 9)}`,
			`${rng.digits(3)} ${rng.digits(3)} ${rng.digits(3)}`,
			`${rng.chars(letters, 1)}${rng.digits(3)}-${rng.digits(3)}-${rng.digits(2)}-${rng.digits(3)}-${rng.digits(1)}`,
		]),
	passport: ({ rng }) => (rng.chance(0.5) ? `${rng.chars(letters, 1)}${rng.digits(8)}` : `5${rng.digits(8)}`),
} satisfies Record<TextIdentifier, (context: DrawContext) => string>;

export const drawIdentifier = (kind: TextIdentifier) => draws[kind];
