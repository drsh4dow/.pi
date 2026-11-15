import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Sample } from "./conversation.ts";
import { diagnoses } from "./health.ts";
import type { Random } from "./random.ts";

const placeholderNames: Arr.NonEmptyReadonlyArray<readonly [string, string]> = [
	["John", "Doe"],
	["Jane", "Doe"],
	["Test", "Patient"],
	["Baby", "Doe"],
	["Richard", "Roe"],
	["Foo", "Bar"],
];

const fakePhone = (rng: Random) =>
	`${rng.pick(["(555) ", "555-", "+1-555-"])}01${String(rng.int(10))}${String(rng.int(10))}`;

const fakeSsn = (rng: Random) => rng.pick(["000-00-0000", "123-45-6789", "999-99-9999", "111-11-1111"]);

const fakeEmail = (rng: Random) =>
	rng.pick(["test@example.com", "john.doe@example.com", "patient@example.org", "noreply@example.net"]);

const fakeDate = (rng: Random) => rng.pick(["1970-01-01", "1900-01-01", "2000-01-01", "1999-12-31"]);

const jestFixture = (rng: Random): Sample => {
	const [given, family] = rng.pick(placeholderNames);
	const diagnosis = rng.pick(diagnoses);

	return {
		scene: {
			asks: [
				"This mapper test fails after the refactor. What changed?",
				"Add a case for a missing diagnosis to this test.",
			],
			commands: ["bun test test/mapper.test.ts"],
			paths: ["test/mapper.test.ts"],
		},
		payload: Arr.join(
			[
				"const fixture = {",
				`  firstName: "${given}",`,
				`  lastName: "${family}",`,
				`  ssn: "${fakeSsn(rng)}",`,
				`  dateOfBirth: "${fakeDate(rng)}",`,
				`  phone: "${fakePhone(rng)}",`,
				`  diagnosisCode: "${diagnosis.code}",`,
				"};",
				"",
				'test("maps a patient row", () => {',
				`  expect(mapRow(fixture).name).toBe("${family}, ${given}");`,
				"});",
			],
			"\n",
		),
	};
};

const factory = (rng: Random): Sample => ({
	scene: {
		asks: [
			"The factory produces duplicate MRNs under parallel tests. Can you fix it?",
			"Port this factory to fishery.",
		],
		commands: ["sed -n '1,30p' spec/factories/patients.rb"],
		paths: ["spec/factories/patients.rb"],
	},
	payload: Arr.join(
		[
			"FactoryBot.define do",
			"  factory :patient do",
			`    first_name { "${rng.pick(["John", "Jane", "Test"])}" }`,
			'    last_name { "Doe" }',
			`    sequence(:mrn) { |n| "TEST-MRN-#{n.to_s.rjust(${String(rng.between(4, 8))}, "0")}" }`,
			`    ssn { "${fakeSsn(rng)}" }`,
			`    email { "${fakeEmail(rng)}" }`,
			`    phone { "${fakePhone(rng)}" }`,
			"  end",
			"end",
		],
		"\n",
	),
});

const formPlaceholders = (rng: Random): Sample => ({
	scene: {
		asks: [
			"The placeholders overflow on mobile. Can you shorten them?",
			"Translate these placeholders for the Spanish build.",
		],
		commands: ["cat src/intake/placeholders.json"],
		paths: ["src/intake/placeholders.json"],
	},
	payload: Arr.join(
		[
			"{",
			'  "name": "John Doe",',
			`  "ssn": "${fakeSsn(rng)}",`,
			`  "phone": "${fakePhone(rng)}",`,
			`  "email": "${fakeEmail(rng)}",`,
			`  "dob": "MM/DD/YYYY",`,
			`  "memberId": "${rng.pick(["XXX000000000", "ABC123456789", "0000000000"])}"`,
			"}",
		],
		"\n",
	),
});

const seedSql = (rng: Random): Sample => {
	const rows = Arr.map(
		Arr.take(rng.shuffle(placeholderNames), rng.between(2, 4)),
		([given, family], index) =>
			`(${String(index + 1)}, '${given}', '${family}', '${fakeDate(rng)}', '${fakeSsn(rng)}', '${Str.toLowerCase(given)}.${Str.toLowerCase(family)}@example.com', '${rng.pick(diagnoses).code}')`,
	);

	return {
		scene: {
			asks: ["The seed script fails on a fresh database. Which insert is wrong?", "Make this seed idempotent."],
			commands: ["psql -f db/seeds/dev_patients.sql intake_dev"],
			paths: ["db/seeds/dev_patients.sql"],
		},
		payload: `-- Development seed data. Fake people only.\nINSERT INTO patients (id, first_name, last_name, date_of_birth, ssn, email, diagnosis_code) VALUES\n${Arr.join(rows, ",\n")};`,
	};
};

const hl7Sample = (rng: Random): Sample => {
	const diagnosis = rng.pick(diagnoses);

	return {
		scene: {
			asks: [
				"Our parser test uses this sample. Why does PID-5 come back empty?",
				"Add this sample to the parser's golden tests.",
			],
			commands: ["cat test/fixtures/adt_a01_sample.hl7"],
			paths: ["test/fixtures/adt_a01_sample.hl7"],
		},
		payload: Arr.join(
			[
				String.raw`MSH|^~\&|TESTAPP|TESTFAC|INTEGRATION|ETL|20000101000000||ADT^A01^ADT_A01|TEST0001|T|2.5.1`,
				`PID|1||TEST${rng.digits(4)}^^^TESTFAC^MR||DOE^JOHN^^^^^L||19700101|M|||123 MAIN ST^^ANYTOWN^ST^00000||${fakePhone(rng)}|||||${fakeSsn(rng)}`,
				`DG1|1||${diagnosis.code}^${diagnosis.text.en}^I10|||A`,
			],
			"\r",
		),
	};
};

const docsExample = (rng: Random): Sample => ({
	scene: {
		asks: ["Proofread the API example in our README.", "Is this curl example still valid against v2?"],
		commands: ["sed -n '40,70p' README.md"],
		paths: ["README.md"],
	},
	payload: Arr.join(
		[
			"## Creating a patient",
			"",
			"```sh",
			"curl -X POST https://api.example.com/v2/patients \\",
			'  -H "Authorization: Bearer $TOKEN" \\',
			`  -d '{"name":"Jane Doe","birthDate":"${fakeDate(rng)}","telecom":"${fakePhone(rng)}","ssn":"${fakeSsn(rng)}"}'`,
			"```",
			"",
			"All values above are placeholders. Never paste real patient data into examples.",
		],
		"\n",
	),
});

export const testFixtures: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	jestFixture,
	factory,
	formPlaceholders,
	seedSql,
	hl7Sample,
	docsExample,
];
