import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Sample } from "./conversation.ts";
import { type Diagnosis, diagnoses } from "./health.ts";
import { type ByLang, foreignLangs } from "./people.ts";
import type { Random } from "./random.ts";

const someDiagnoses = (rng: Random) => Arr.take(rng.shuffle(diagnoses), rng.between(4, 8));

const codeTable = (rng: Random): Sample => ({
	scene: {
		asks: [
			"Can you turn this lookup into a Map and add a test for unknown codes?",
			"Is this ICD-10 table complete for the chronic care report?",
		],
		commands: ["sed -n '1,40p' src/reference/icd10.ts"],
		paths: ["src/reference/icd10.ts"],
	},
	payload: Arr.join(
		[
			"/** ICD-10-CM codes the chronic care dashboard groups by. */",
			"export const chronicConditions: Record<string, string> = {",
			...Arr.map(someDiagnoses(rng), ({ code, text }) => `  "${code}": "${text.en}",`),
			"};",
		],
		"\n",
	),
});

const drugOf = (sig: string) => Arr.headNonEmpty(Str.split(" ")(sig));

const rule = ({ code, text, medication }: Diagnosis) =>
	Arr.join(
		[
			`  if (codes.has("${code}") && !active.some((drug) => drug.startsWith("${drugOf(medication.en)}"))) {`,
			`    alerts.push({ code: "${code}", message: "${text.en}: consider ${medication.en}" });`,
			"  }",
		],
		"\n",
	);

const decisionSupport = (rng: Random): Sample => ({
	scene: {
		asks: [
			"These care-gap alerts fire twice. Can you dedupe them?",
			"Refactor this rule engine into a table of rules.",
		],
		commands: ["git show HEAD:src/cds/care-gaps.ts | head -50"],
		paths: ["src/cds/care-gaps.ts"],
	},
	payload: Arr.join(
		[
			"export function careGaps(codes: Set<string>, active: string[]): Alert[] {",
			"  const alerts: Alert[] = [];",
			...Arr.map(someDiagnoses(rng), rule),
			"  return alerts;",
			"}",
		],
		"\n",
	),
});

const interactions = (rng: Random): Sample => ({
	scene: {
		asks: [
			"The interaction checker misses a pair from this table. Which one?",
			"Load this table into the formulary service.",
		],
		commands: ["head -20 data/formulary/interactions.csv"],
		paths: ["data/formulary/interactions.csv"],
	},
	payload: Arr.join(
		[
			"drug_a,drug_b,severity,note",
			...Arr.take(
				rng.shuffle([
					"warfarin,amiodarone,major,Increased INR and bleeding risk; reduce warfarin dose",
					"sertraline,tramadol,major,Serotonin syndrome risk",
					"lisinopril,spironolactone,moderate,Hyperkalemia; monitor potassium",
					"metformin,iodinated contrast,moderate,Hold metformin 48 hours after contrast",
					"levetiracetam,alcohol,minor,Additive CNS depression",
					"simvastatin,clarithromycin,major,Myopathy and rhabdomyolysis",
					"furosemide,gentamicin,moderate,Ototoxicity",
					"apixaban,ketoconazole,major,Raised apixaban levels",
				]),
				rng.between(4, 8),
			),
		],
		"\n",
	),
});

const valueSet = (rng: Random): Sample => ({
	scene: {
		asks: [
			"The terminology server rejects this ValueSet. Is the compose block valid?",
			"Add the missing codes to this ValueSet.",
		],
		commands: ["cat fhir/valuesets/chronic-conditions.json"],
		paths: ["fhir/valuesets/chronic-conditions.json"],
	},
	payload: Arr.join(
		[
			'{"resourceType":"ValueSet","id":"chronic-conditions","status":"draft",',
			'"compose":{"include":[{"system":"http://hl7.org/fhir/sid/icd-10-cm","concept":[',
			...Arr.map(someDiagnoses(rng), ({ code, text }) => `{"code":"${code}","display":"${text.en}"},`),
			'{"code":"Z00.00","display":"Encounter for general adult medical examination without abnormal findings"}',
			"]}]}}",
		],
		"\n",
	),
});

const aggregate = (rng: Random): Sample => ({
	scene: {
		asks: [
			"The monthly totals in this report don't add up. Can you check the SQL behind it?",
			"Plot these counts by month.",
		],
		commands: ["psql -c 'SELECT * FROM reporting.monthly_dx_counts' analytics"],
		paths: ["reports/monthly_dx_counts.txt"],
	},
	payload: Arr.join(
		[
			" month   | diagnosis_code | description                                   | encounters",
			"---------+----------------+-----------------------------------------------+-----------",
			...Arr.map(
				someDiagnoses(rng),
				({ code, text }) =>
					` 2025-0${String(rng.between(1, 9))} | ${Str.padEnd(14)(code)} | ${Str.padEnd(45)(Str.slice(0, 45)(text.en))} | ${Str.padStart(10)(String(rng.between(40, 3000)))}`,
			),
		],
		"\n",
	),
});

const sigTest = (rng: Random): Sample => ({
	scene: {
		asks: ["Why does the sig parser fail on these?", "Add cases for PRN dosing to this test."],
		commands: ["bun test test/sig-parser.test.ts"],
		paths: ["test/sig-parser.test.ts"],
	},
	payload: Arr.join(
		Arr.map(
			someDiagnoses(rng),
			({ medication }) =>
				`test("${medication.en}", () => {\n  expect(parseSig("${medication.en}").dose).toBeDefined();\n});`,
		),
		"\n\n",
	),
});

const titles = {
	en: "Diagnoses",
	es: "Diagnósticos",
	de: "Diagnosen",
	fr: "Diagnostics",
	pt: "Diagnósticos",
	vi: "Chẩn đoán",
} satisfies ByLang<string>;

const glossary = (rng: Random): Sample => {
	const lang = rng.pick(foreignLangs);

	return {
		scene: {
			asks: [
				"The translated diagnosis labels don't show up in the portal. Is this locale file wrong?",
				"Check these translations against the English keys.",
			],
			commands: [`cat locales/${lang}/diagnoses.json`],
			paths: [`locales/${lang}/diagnoses.json`],
		},
		payload: Arr.join(
			[
				"{",
				...Arr.map(someDiagnoses(rng), ({ code, text }) => `  "dx.${code}": "${text[lang]}",`),
				`  "dx.title": "${titles[lang]}"`,
				"}",
			],
			"\n",
		),
	};
};

export const medicalTerms: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	codeTable,
	decisionSupport,
	interactions,
	valueSet,
	aggregate,
	sigTest,
	glossary,
];
