/**
 * The PHI policy: the one written source for what seals a message. `policyVersion` hashes all of it with the rules and
 * the judge model, so an edit here retires every stored verdict without a hand-bumped number.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";

import { sha256 } from "./digest.ts";
import { rules } from "./rules.ts";

/** The plan's PHI table. Each kind is a direct identifier of a real patient or member, as the judge reads it. */
export const identifierKinds = {
	"patient-name": "a real patient's or member's name",
	ssn: "a Social Security number",
	"birth-date": "a full date of birth",
	"street-address": "a home street address",
	"personal-phone": "a personal phone number",
	"personal-email": "a personal email address",
	"member-number": "an insurance member or subscriber number",
	"medicare-medicaid-number": "a Medicare or Medicaid number",
	mrn: "a provider's medical record number",
	"driver-license": "a driver license number",
	passport: "a passport number",
	"face-photo": "a face photo, or an image that shows any of these",
} as const;

export type IdentifierKind = keyof typeof identifierKinds;

/** The plan's defaults the human can change. Edit the sentence; the judge reads it as written. */
export const defaults = [
	"Insurance member numbers and a provider's medical record numbers count.",
	"A real patient's or member's name counts even with no health facts.",
	"Clinical dates other than a date of birth count only next to a direct identifier of the same person.",
] as const;

/** Content the judge must clear. Short, because the list rides on every judge call. */
export const counterExamples = [
	{ text: "patient_id 4471, asthma, sync failed at step 3", why: "a health fact tied only to an internal id" },
	{ text: "SELECT patient_id, dx_code FROM encounters WHERE client_code = 'C-102'", why: "schema and SQL" },
	{ text: "row 88123, uuid 550e8400-e29b-41d4-a716-446655440000", why: "internal ids" },
	{ text: "Ask Dana Whitfield (vendor support), dana@vendor.example", why: "a vendor contact" },
	{ text: "Dr. Ruth Okafor, cardiology, ext. 4410", why: "a staff contact" },
	{ text: "...son, DOB 19", why: "a fragment" },
	{ text: "412 members had a claim denied in March", why: "a count" },
] as const;

/** Exact test identities, from the human. Settings add to them. Nothing is exempt for merely looking like a placeholder. */
export interface SyntheticIdentities {
	readonly exact: ReadonlyArray<string>;
	/** A token that starts with one of these is a test identity, such as a staging client code. */
	readonly prefixes: ReadonlyArray<string>;
}

export const syntheticIdentities: SyntheticIdentities = { exact: [], prefixes: [] };

/** What a listed test identity reads as, to the rules and the judge. */
export const syntheticMark = "[synthetic-id]";

/** Constant per class, so a stub never changes and a personal account's cache prefix stays stable. */
export const stubs = {
	sealed: "[withheld: holds patient identifiers, handled on the HIPAA account]",
	unknown: "[withheld: not checked for patient identifiers]",
} as const;

const readingRules = `\`piece\` is new content from a developer's session with a coding agent: a message, pasted text, tool or file output, or part of a system prompt. \`context\` is earlier content that already cleared, for reading only: judge \`piece\`, not \`context\`. ${stubs.sealed} in \`context\` stands for earlier content that was withheld.`;

const kindList = Arr.join(Rec.values(identifierKinds), "; ");

const counterList = Arr.join(
	Arr.map(counterExamples, ({ text, why }) => `"${text}" (${why})`),
	"; ",
);

/** What counts and what does not. Both questions carry it, so the band's kind answer applies the same policy. */
const countingRules = [
	`Direct identifiers: ${kindList}.`,
	...defaults,
	"An image counts only when it shows a face or one of these identifiers.",
	`${syntheticMark} marks a listed test identity that was removed; it identifies no one.`,
	`Treat every other value as a real person's: a value that looks invented, a placeholder, an example domain or a reserved number range still counts.`,
	"A name, phone, email, address, date of birth or record or member number that could belong to a patient or member counts, wherever it appears (a file name, a log, a table, a header). Clear it only when the text shows it belongs to staff, a vendor or a business.",
	"Encoded, minified, misspelled or buried values count.",
	`Not direct identifiers: internal ids, health facts tied only to an internal id, code, schemas, logs and SQL, staff, vendor and business contacts, fragments, counts. For example: ${counterList}.`,
];

export const identifierQuestion = {
	type: "bool",
	instructions: Arr.join(
		[
			readingRules,
			"Does `piece` contain a complete direct identifier of a real patient or health-plan member?",
			...countingRules,
		],
		" ",
	),
	criteria: {
		true: "`piece` holds, or likely holds, a complete direct identifier that could belong to a patient or member.",
		false: `\`piece\` holds no complete direct identifier of a patient or member: only internal ids, code, schemas, staff or vendor contacts, fragments, counts or values shown as ${syntheticMark}.`,
	},
} as const;

/** Asked in the borderline band, and to label a seal. */
export const kindQuestion = {
	type: "choice",
	instructions: Arr.join(
		[
			readingRules,
			"Which direct identifier of a real patient or member does `piece` contain? Answer none only when it holds none.",
			...countingRules,
		],
		" ",
	),
	criteria: { ...identifierKinds, none: "no direct identifier of a real patient or member" },
} as const;

/**
 * `p < clearBelow` clears and `p >= sealAtOrAbove` seals. In between, the kind question decides. A system part seals
 * only at or above `sealAtOrAbove` with a named kind.
 */
export const thresholds = { clearBelow: 0.2, sealAtOrAbove: 0.5 } as const;

/** The shortest line, trimmed, that counts as an \`ent\` reply repeating sealed content. */
export const quoteMinChars = 16;

/** How many preceding rendered items the judge sees beside a piece. For a tool result the first is its own call. */
export const window = 1;

/** Decisions' limits: characters per call, images per call, and how long one call may take. */
export const judgeLimits = { maxChars: 2_000_000, maxImages: 128, timeoutMs: 20_000 } as const;

export const judgeModel = "gpt-6-luna";

export const PolicyVersion = Schema.String.pipe(Schema.brand("PolicyVersion"));

export type PolicyVersion = typeof PolicyVersion.Type;

/** Plain data, so encoding cannot fail. */
const jsonOf = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const ruleSources = Arr.map(rules, ({ id, kind, pattern }) => ({
	id,
	kind,
	source: pattern.source,
	flags: pattern.flags,
}));

const everything = jsonOf({
	identifierKinds,
	defaults,
	counterExamples,
	syntheticIdentities,
	syntheticMark,
	stubs,
	identifierQuestion,
	kindQuestion,
	thresholds,
	quoteMinChars,
	window,
	judgeLimits,
	judgeModel,
	rules: ruleSources,
});

/** Everything above, hashed. A stored verdict from another version is ignored and judged again. */
export const policyVersion: PolicyVersion = PolicyVersion.make(sha256(everything.pipe(Option.getOrThrow)));
