import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { digitsOf, isSsn } from "./scan-checks.ts";
import { labelledRules } from "./scan-labelled.ts";
import type { Rule } from "./scan-rule.ts";

const groupOf = (match: RegExpMatchArray, name: string) => match.groups?.[name] ?? "";

const hasValue = (field: string | undefined) => field !== undefined && /[a-z\d]/iu.test(field);

/** PID-3 (identifiers), PID-5 (name) or PID-7 (birth date) holds a value. */
const pidHasValues = (match: RegExpMatchArray) => {
	const [segment] = Str.split(/\\[rn]/u)(groupOf(match, "fields"));
	const fields = Str.split("|")(segment);

	return hasValue(fields[2]) || hasValue(fields[4]) || hasValue(fields[6]);
};

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
];

const holdsSomewhere = (rule: Omit<Rule, "id" | "category">, text: string) => {
	for (const match of Str.matchAll(rule.pattern)(text)) {
		if (rule.holds(match, text)) {
			return true;
		}
	}

	return false;
};

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
	...recordRules,
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
