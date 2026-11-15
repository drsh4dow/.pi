import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { digitsOf, isSsn, isVin, namesSomeone } from "./checks.ts";
import { labelledRules } from "./labelled.ts";
import { around, labelled, nameValue, street, type Rule } from "./rule.ts";

const groupOf = (match: RegExpMatchArray, name: string) => match.groups?.[name] ?? "";

const numbered = String.raw`[ _-]?(?:number|num|no\.?|#)`;

const hasValue = (field: string | undefined) => field !== undefined && /[a-z\d]/iu.test(field);

/** PID-3 (identifiers), PID-5 (name) or PID-7 (birth date) holds a value. */
const pidHasValues = (match: RegExpMatchArray) => {
	const [segment] = Str.split(/\\[rn]/u)(groupOf(match, "fields"));
	const fields = Str.split("|")(segment);

	return hasValue(fields[2]) || hasValue(fields[4]) || hasValue(fields[6]);
};

const clinicalResources =
	"Observation|Condition|Encounter|Procedure|MedicationRequest|MedicationStatement|MedicationAdministration|DiagnosticReport|AllergyIntolerance|Immunization|CarePlan|ServiceRequest|DocumentReference|Appointment|Claim|ExplanationOfBenefit|Coverage";

const recordRules: ReadonlyArray<Rule> = [
	{
		id: "hl7-pid",
		category: "mrn",
		pattern: /MSH\|\^~\\&\|[\s\S]{0,4000}?(?:[^A-Za-z\d]|\\[rn])PID\|(?<fields>[^\r\n]*)/gu,
		holds: pidHasValues,
	},
	{
		id: "x12-claim",
		category: "health-plan",
		pattern: /ISA\*[\s\S]{0,4000}?(?:ST\*837\*|NM1\*(?:IL|QC)\*[12]\*[A-Za-z])/gu,
		holds: () => true,
	},
	{
		id: "fhir-patient",
		category: "name",
		pattern:
			/"resourceType"\s*:\s*"Patient"[\s\S]{0,3000}?(?:"birthDate"\s*:\s*"\d{4}-\d\d-\d\d"|"family"\s*:\s*"[A-Za-z]|"given"\s*:\s*\[\s*"[A-Za-z]|"identifier"\s*:\s*\[[^\]]{0,500}?"value"\s*:\s*"[^"\s]{3,}")/gu,
		holds: () => true,
	},
	{
		id: "fhir-subject",
		category: "other-id",
		pattern: new RegExp(
			String.raw`"resourceType"\s*:\s*"(?:${clinicalResources})"[\s\S]{0,3000}?"(?:subject|patient|beneficiary)"\s*:\s*\{\s*"reference"\s*:\s*"Patient/(?<id>[A-Za-z\d.-]{1,64})"`,
			"gu",
		),
		holds: () => true,
	},
];

const personName = new RegExp(
	String.raw`(?<![a-z])(?<label>(?:patient|pt|full|legal|member|subscriber|insured|guarantor|beneficiary|first|last|given|family|sur|maiden)[ _-]?name|patient)(?![a-z])[\s"']{0,2}[:=][\s"']{0,3}(?<name>${nameValue})`,
	"giu",
);

const isPersonName = (match: RegExpMatchArray) =>
	namesSomeone({
		name: groupOf(match, "name"),
		fewest: Str.toLowerCase(groupOf(match, "label")) === "patient" ? 2 : 1,
	});

/** NANP area and exchange codes never start with 0 or 1. */
const isPhone = (match: RegExpMatchArray) =>
	/^[2-9]/u.test(groupOf(match, "area") || groupOf(match, "areaPlain")) && /^[2-9]/u.test(groupOf(match, "exchange"));

const neighbors: ReadonlyArray<Omit<Rule, "category">> = [
	{
		id: "name-near-phone",
		pattern:
			/(?<![\d.-])(?:\+?1[-. ]?)?(?:\((?<area>\d{3})\)[-. ]?|(?<areaPlain>\d{3})[-. ])(?<exchange>\d{3})[-. ](?<line>\d{4})(?![\d-]|\.\d)/gu,
		holds: isPhone,
	},
	{
		id: "name-near-email",
		pattern: /(?<![\w.+-])[\w.+-]+@[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}(?![\w-])/giu,
		holds: () => true,
	},
	{
		id: "name-near-address",
		pattern: new RegExp(String.raw`(?<![\w-])${street}`, "gu"),
		holds: () => true,
	},
];

const holdsSomewhere = (rule: Omit<Rule, "id" | "category">, text: string) => {
	for (const match of Str.matchAll(rule.pattern)(text)) {
		if (rule.holds(match, text)) {
			return true;
		}
	}

	return false;
};

const nearName = (neighbor: Omit<Rule, "category">) => (match: RegExpMatchArray) =>
	isPersonName(match) && holdsSomewhere(neighbor, around(match));

const rules: ReadonlyArray<Rule> = [
	{
		id: "ssn",
		category: "ssn",
		pattern: /(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/gu,
		holds: ([ssn]) => isSsn(digitsOf(ssn)),
	},
	{
		id: "mbi",
		category: "health-plan",
		pattern:
			/(?<![\w-])[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y]{2}\d\d(?![\w-])/gu,
		holds: () => true,
	},
	{ id: "vin", category: "vehicle", pattern: /(?<![\w-])[A-HJ-NPR-Z\d]{17}(?![\w-])/gu, holds: ([vin]) => isVin(vin) },
	{
		id: "npi",
		category: "other-id",
		pattern: labelled({
			label: String.raw`npi(?:${numbered})?|us-npi"\s*,\s*"value"`,
			value: String.raw`\d{10}(?!\d)`,
		}),
		holds: () => true,
	},
	{
		id: "dea",
		category: "license",
		pattern: labelled({
			label: String.raw`dea(?:${numbered}|[ _-]?registration)?`,
			value: String.raw`[a-z][a-z9]\d{7}(?![a-z\d])`,
		}),
		holds: () => true,
	},
	...recordRules,
	...Arr.map(neighbors, (neighbor): Rule => ({
		id: neighbor.id,
		category: "name",
		pattern: personName,
		holds: nearName(neighbor),
	})),
];

/**
 * The first rule that finds PHI in a transcript's rendered turns. The labelled rules read each turn on its own, so a
 * value cut off where a turn ends still counts.
 */
export const firstHit = (turns: ReadonlyArray<string>) => {
	const transcript = Arr.join(turns, "\n");

	return Option.orElse(
		Arr.findFirst(rules, (rule) => holdsSomewhere(rule, transcript)),
		() => Arr.findFirst(labelledRules, (rule) => Arr.some(turns, (turn) => holdsSomewhere(rule, turn))),
	);
};
