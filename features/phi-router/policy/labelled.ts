import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { hasDigit, namesSomeone } from "./checks.ts";
import type { SafeHarbor } from "./index.ts";
import { labelled, nameValue, street, type Rule } from "./rule.ts";

const month = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;

const day = String.raw`(?:0?[1-9]|[12]\d|3[01])`;

const date = String.raw`(?:19|20)\d\d-(?:0?[1-9]|1[0-2])-${day}|${day}[/.-]${day}[/.-](?:\d{4}|\d\d)|(?:19|20)\d\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|${month}\s+${day}(?:st|nd|rd|th)?,?\s+\d{4}|${day}(?:st|nd|rd|th)?\s+${month},?\s+\d{4}`;

interface LabelledIdentifier {
	readonly unambiguous: ReadonlyArray<string>;
	readonly ambiguous: ReadonlyArray<string>;
	readonly value: string;
	readonly holds: (value: string) => boolean;
}

const spellings = new Map([
	["patient", "(?:patient|pt)"],
	["driver", "driver'?s?"],
	["license", "licen[cs]e"],
	["no", String.raw`(?:number|num|nbr|no\.?|#)`],
	["id", String.raw`(?:id|identifier|number|num|nbr|no\.?|#)`],
]);

const escaped = Str.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const labelPattern = (label: string) =>
	Arr.join(
		Arr.map(Str.split(" ")(label), (word) => spellings.get(word) ?? escaped(word)),
		"[ _-]?",
	);

const anyOf = (labels: ReadonlyArray<string>) => {
	const longestFirst = Arr.sortWith(labels, Str.length, Order.flip(Order.Number));

	return labels.length === 0 ? "(?!)" : Arr.join(Arr.map(longestFirst, labelPattern), "|");
};

const identifier = String.raw`(?=(?:[-.]?[a-z\d]){5})[a-z\d]+(?:[-.][a-z\d]+)*(?!\w)`;

const nanp = String.raw`(?:\+?1[-. ]?)?(?:\([2-9]\d\d\)|[2-9]\d\d)[-. ]?[2-9]\d\d[-. ]?\d{4}(?!\d)`;

const octet = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;

const always = () => true;

const notCode = String.raw`(?![\w(\[<]|\.\w)`;

const labelledIdentifiers = {
	name: {
		unambiguous: [
			"patient name",
			"full name",
			"legal name",
			"member name",
			"subscriber name",
			"insured name",
			"guarantor name",
			"beneficiary name",
			"maiden name",
		],
		ambiguous: ["first name", "last name", "given name", "family name", "surname"],
		value: String.raw`${nameValue}${notCode}`,
		holds: (name) => namesSomeone({ name, fewest: 1 }),
	},
	geographic: {
		unambiguous: [
			"home address",
			"street address",
			"mailing address",
			"residential address",
			"patient address",
			"address line 1",
			"zip code",
			"postal code",
			"post code",
		],
		ambiguous: ["zip"],
		value: String.raw`${street}|\d{5}(?:-\d{4})?(?![\d-])`,
		holds: hasDigit,
	},
	date: {
		unambiguous: [
			"date of birth",
			"dob",
			"d.o.b.",
			"d.o.b",
			"birth date",
			"birthday",
			"date of death",
			"death date",
			"admission date",
			"admit date",
			"discharge date",
			"date of service",
		],
		ambiguous: ["born", "born on", "dod", "service date", "visit date"],
		value: String.raw`(?:${date})(?!\d)`,
		holds: hasDigit,
	},
	phone: {
		unambiguous: [
			"phone",
			"phone no",
			"telephone",
			"telephone no",
			"home phone",
			"cell phone",
			"mobile phone",
			"mobile no",
		],
		ambiguous: ["tel", "cell", "mobile"],
		value: nanp,
		holds: hasDigit,
	},
	fax: { unambiguous: ["fax", "fax no", "facsimile"], ambiguous: [], value: nanp, holds: hasDigit },
	email: {
		unambiguous: ["e mail", "e mail address"],
		ambiguous: [],
		value: String.raw`[\w.+-]+@[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}(?![\w-])`,
		holds: always,
	},
	ssn: {
		unambiguous: ["ssn", "ssn no", "social security", "social security no"],
		ambiguous: ["ss no"],
		value: String.raw`\d{3}[ -]?\d\d[ -]?\d{4}(?![\d-])`,
		holds: hasDigit,
	},
	mrn: {
		unambiguous: ["mrn", "mrn id", "medical record", "medical record id", "patient id"],
		ambiguous: ["chart id", "mr no"],
		value: identifier,
		holds: hasDigit,
	},
	"health-plan": {
		unambiguous: [
			"member id",
			"subscriber id",
			"insured id",
			"beneficiary id",
			"medicaid id",
			"medicare id",
			"insurance id",
			"health plan id",
			"mbi",
			"hicn",
		],
		ambiguous: ["policy no", "group no"],
		value: identifier,
		holds: hasDigit,
	},
	account: { unambiguous: ["account no", "acct no"], ambiguous: [], value: identifier, holds: hasDigit },
	license: {
		unambiguous: ["driver license", "driver license no", "driving license", "driving license no"],
		ambiguous: ["license no", "dl no", "dl"],
		value: identifier,
		holds: hasDigit,
	},
	vehicle: {
		unambiguous: ["vin", "vehicle identification no", "license plate", "license plate no", "plate no"],
		ambiguous: ["vehicle id", "tag no"],
		value: identifier,
		holds: hasDigit,
	},
	device: {
		unambiguous: ["device serial", "device serial no", "implant serial", "implant serial no", "udi"],
		ambiguous: ["device id"],
		value: identifier,
		holds: hasDigit,
	},
	url: {
		unambiguous: ["patient url", "personal url", "personal website", "profile url"],
		ambiguous: [],
		value: String.raw`https?://[^\s"'<>]+`,
		holds: always,
	},
	ip: {
		unambiguous: ["client ip", "remote ip", "remote addr", "user ip", "patient ip"],
		ambiguous: ["ip", "ip address", "source ip", "x forwarded for"],
		value: String.raw`${octet}(?:\.${octet}){3}(?!\.?\d)|[a-f\d]{1,4}(?::[a-f\d]{0,4}){2,7}(?![\w:])`,
		holds: hasDigit,
	},
	biometric: {
		unambiguous: [
			"biometric template",
			"biometric hash",
			"biometric id",
			"fingerprint template",
			"patient fingerprint",
			"voiceprint",
			"faceprint",
			"face template",
			"iris template",
		],
		ambiguous: ["biometric"],
		value: String.raw`(?:[a-f\d]{32,}|[a-z\d+/]{40,}={0,2})(?![\w+/=])`,
		holds: always,
	},
	photo: {
		unambiguous: ["patient photo", "profile photo", "headshot"],
		ambiguous: ["photo"],
		value: String.raw`[\w./-]+\.(?:jpe?g|png|gif|bmp|tiff?|heic|webp|dcm)(?![\w.])`,
		holds: always,
	},
	"other-id": {
		unambiguous: ["passport", "passport no", "national id"],
		ambiguous: ["state id"],
		value: identifier,
		holds: hasDigit,
	},
} satisfies Record<SafeHarbor, LabelledIdentifier>;

const cut = String.raw`[^\s"'<>]+(?: [\d(][^\s"'<>]*){0,2}`;

/**
 * The end of a turn, past trailing whitespace, the file lists pi's compaction appends to a summary, and closing tags
 * such as the `</summary>` pi wraps it in.
 */
const turnEnd = String.raw`(?=\s*(?:<(?<list>read-files|modified-files)>[^<]*</\k<list>>\s*)*(?:</[a-z][\w-]*>\s*)*$)`;

const shortestCut = 3;

const labelledRule = ([category, { unambiguous, ambiguous, value, holds }]: [
	SafeHarbor,
	LabelledIdentifier,
]): Rule => ({
	id: `labelled-${category}`,
	category,
	pattern: labelled({
		label: String.raw`(?:(?:patient|pt)[ _-]?)?(?:(?<unambiguous>${anyOf(unambiguous)})|${anyOf(ambiguous)})`,
		value: String.raw`(?:(?<value>${value})|(?<cut>${cut})${turnEnd})`,
	}),
	holds: (match) => {
		const cutValue = match.groups?.["cut"];

		if (cutValue === undefined) {
			return holds(match.groups?.["value"] ?? "");
		}

		return (
			match.groups?.["unambiguous"] !== undefined &&
			Str.replaceAll(/[^a-z\d]/giu, "")(cutValue).length >= shortestCut &&
			holds(cutValue)
		);
	},
});

const endsAtWordBreak = (first: string, joined: string) =>
	joined === "" || (/[a-z]$/u.test(first) && /^[A-Z]/u.test(joined));

const patientSide: Rule = {
	id: "labelled-patient-side",
	category: "other-id",
	pattern: labelled({
		label: String.raw`(?<![\w-])(?<first>patient|pt|member|subscriber|beneficiary|insured|guarantor)(?<joined>[a-z]*)(?:[ _-][a-z]+)*`,
		value: String.raw`[^\s"'<>]*\d[^\s"'<>]*`,
	}),
	holds: (match) => endsAtWordBreak(match.groups?.["first"] ?? "", match.groups?.["joined"] ?? ""),
};

export const labelledRules = [...Arr.map(Rec.toEntries(labelledIdentifiers), labelledRule), patientSide];
