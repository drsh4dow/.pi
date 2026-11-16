import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import type { IdentifierKind } from "./policy.ts";

/** One HL7 v2 field: anything up to the next `|` or segment end, a literal `\r` or `\n` in serialized text included. */
const hl7Field = String.raw`(?:[^|\r\n\\]|\\(?![rn]))*`;

/** An HL7 v2 field holding a letter or digit, not only component separators such as `^^`. */
const hl7Filled = String.raw`[^|\r\n\\\p{L}\p{N}]*[\p{L}\p{N}]`;

/** A FHIR identifier `system` naming an SSN, MBI or member-number system. */
const memberSystem = String.raw`"system"\s*:\s*"[^"]*(?:ssn|mbi|medicare|member)[^"]*"`;

const filledValue = String.raw`"value"\s*:\s*"[^"\s]`;

/**
 * Rules for unambiguous direct identifiers only. A hit seals; rules never clear. Each rule is its pattern alone, so
 * `policyVersion`, which hashes every pattern, changes whenever a rule does.
 */
export const rules = [
	{
		id: "ssn",
		kind: "ssn",
		// The SSA never issues area 000, 666 or 9xx, group 00 or serial 0000.
		pattern: /(?<![\w-])(?!000|666|9\d\d)\d{3}-(?!00)\d\d-(?!0000)\d{4}(?![\w-])/u,
	},
	{
		id: "mbi",
		kind: "medicare-medicaid-number",
		pattern:
			/(?<![\w-])[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y]{2}\d\d(?![\w-])/u,
	},
	{
		id: "hl7-pid",
		kind: "patient-name",
		// A PID segment whose PID-5 (name) or PID-7 (birth date) is filled. PID-3 alone is often an internal handle.
		pattern: new RegExp(
			String.raw`MSH\|\^~\\&\|[\s\S]{0,4000}?(?:[^\p{L}\p{N}]|\\[rn])PID\|(?:${hl7Field}\|){4}(?:${hl7Filled}|${hl7Field}\|${hl7Field}\|${hl7Filled})`,
			"u",
		),
	},
	{
		id: "fhir-patient",
		kind: "patient-name",
		// Within one Patient resource. A resource that only references `Patient/<id>` is not one.
		pattern: new RegExp(
			String.raw`"resourceType"\s*:\s*"Patient"(?:(?!"resourceType")[\s\S]){0,3000}?(?:"birthDate"\s*:\s*"\d{4}-\d\d-\d\d"|"family"\s*:\s*"\p{L}|"given"\s*:\s*\[\s*"\p{L}|${memberSystem}[^{}]*?${filledValue}|${filledValue}[^"]*"[^{}]*?${memberSystem})`,
			"u",
		),
	},
	{
		id: "x12-member",
		kind: "member-number",
		// NM1 subscriber or patient with a filled last name (NM103) or member id (NM109), inside an ISA envelope.
		pattern: /ISA\*[\s\S]{0,4000}?NM1\*(?:IL|QC)\*[12]\*(?:\p{L}|(?:[^*~\r\n]*\*){6}[\p{L}\p{N}])/u,
	},
] as const satisfies ReadonlyArray<{ readonly id: string; readonly kind: IdentifierKind; readonly pattern: RegExp }>;

export type RuleId = (typeof rules)[number]["id"];

interface RuleHit {
	readonly rule: RuleId;
	readonly kind: IdentifierKind;
}

/** The first rule that fires on `text`: a piece's text with its decoded readings, after synthetic blanking. */
export const firstHit = (text: string): Option.Option<RuleHit> =>
	Option.map(
		Arr.findFirst(rules, ({ pattern }) => pattern.test(text)),
		({ id, kind }) => ({ rule: id, kind }),
	);
