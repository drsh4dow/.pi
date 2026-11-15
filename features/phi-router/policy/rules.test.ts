import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as Str from "effect/String";

import { Phi, ScanResult, type SafeHarbor } from "./index.ts";
import { assistant, clearedCursor, scanWith, tool, user } from "./judge.fixture.ts";

const run = (body: Effect.Effect<void>) => Effect.runPromise(body);

const ruleTaint = (rule: string, category: SafeHarbor) =>
	ScanResult.Tainted({
		taint: Phi.make({ detector: "rule", rule, category }),
		fresh: true,
		stats: { newChars: 0, judgeCalls: 0, judgeMs: 0 },
	});

const hits: ReadonlyArray<readonly [rule: string, category: SafeHarbor, text: string]> = [
	["ssn", "ssn", "Patient SSN 078-05-1120 on file"],
	["labelled-ssn", "ssn", "INSERT INTO members (ssn) VALUES ('078051120');\n-- ssn=078051120"],
	["mbi", "health-plan", "Medicare beneficiary 3WR7-KX2-PN45 was billed twice"],
	["vin", "vehicle", "Accident report: vehicle 1M8GDM9AXKP042788"],
	["npi", "other-id", "referring provider NPI: 1245319599"],
	["labelled-mrn", "mrn", '{"patient_id": "00482913", "status": "admitted"}'],
	["labelled-health-plan", "health-plan", "Member ID: XGH492817305"],
	["labelled-account", "account", "Account #: 4482019375"],
	["labelled-license", "license", "Driver's license number: D4829173"],
	["dea", "license", "prescriber DEA# BM4829175"],
	["labelled-date", "date", "DOB: 03/14/1962"],
	[
		"hl7-pid",
		"mrn",
		"MSH|^~\\&|EPIC|HOSP|||20240105||ADT^A01|1|P|2.5\rPID|1||00482913^^^MRN||QUINTERO^MARISOL||19620314|F",
	],
	["x12-claim", "health-plan", "ISA*00*          *00*          *ZZ*SUBMITTER~GS*HC*X~ST*837*0001*005010X222A1~"],
	[
		"fhir-patient",
		"name",
		'{"resourceType": "Patient", "id": "8812", "name": [{"family": "Quintero", "given": ["Marisol"]}]}',
	],
	[
		"fhir-subject",
		"other-id",
		'{"resourceType":"Observation","status":"final","subject":{"reference":"Patient/8812"}}',
	],
	["name-near-phone", "name", "patient_name: Marisol Quintero, phone: (312) 847-2210"],
	["name-near-email", "name", '{"first_name": "Marisol", "email": "mquintero@example.com"}'],
	["name-near-address", "name", "Patient: Marisol Quintero, 4821 Oak Ridge Rd, Springfield"],
	["labelled-name", "name", "patient_name: Marisol Quintero"],
	["labelled-geographic", "geographic", "homeAddress: 4821 Oak Ridge Rd"],
	["labelled-phone", "phone", "Phone: (312) 847-2210"],
	["labelled-fax", "fax", "fax=312-847-2299"],
	["labelled-email", "email", '"email": "mquintero@gmail.com"'],
	["labelled-vehicle", "vehicle", "license plate: 7ABC123"],
	["labelled-device", "device", "device_serial_no: PM4471-88213"],
	["labelled-url", "url", "personal website: https://mquintero.blog/about"],
	["labelled-ip", "ip", "client_ip=73.162.44.18"],
	["labelled-biometric", "biometric", "fingerprint_template: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"],
	["labelled-photo", "photo", "ptPhoto: mquintero_2024.jpg"],
	["labelled-other-id", "other-id", "Passport No.: 548812937"],
	["labelled-patient-side", "other-id", "rejected: patient_ref_no 12, retrying"],
	["labelled-patient-side", "other-id", "member-alt-key: A123 not found"],
	["labelled-patient-side", "other-id", "subscriberGroupCode=77Q"],
	["labelled-patient-side", "other-id", "Insured party number 4471 on hold"],
];

for (const [rule, category, text] of hits) {
	test(`rule ${rule} taints: ${text}`, () =>
		run(
			Effect.gen(function* () {
				const { result, asked } = yield* scanWith({ transcript: [user(text)] });

				expect(result).toEqual(ruleTaint(rule, category));
				expect(asked).toEqual([]);
			}),
		));
}

const lookAlikes: ReadonlyArray<string> = [
	"request_id=550e8400-e29b-41d4-a716-446655440000 took 1234ms at 2024-01-15T10:22:33Z",
	"bumped effect 4.1.2 -> 4.1.3, build #20240115.3",
	"commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
	"impossible SSNs 000-12-3456, 666-12-3456, 912-56-7823, 412-00-3456 and 412-56-0000",
	"MRN: 4821, build 1M8GDM9A1KP042788",
	"CREATE TABLE patient (ssn text, mrn VARCHAR(20), dob DATE, patient_name text, member_id bigint);",
	"interface Patient { mrn: string; dob: Date; first_name: String }",
	"sig=Kq2+mrn48213UzaTunn7/Dli",
	"first_name: null, callback (312) 847-2210",
	"patient: Pending, callback (312) 847-2210",
	"license: MIT, policy_id: 12345678, group_id: 100123, account_id: 123456789012",
	"MSH|^~\\&|EPIC|HOSP\rPID|||||",
	'{"resourceType": "Patient", "id": "example"}',
	"token mRn9iXX9Sfj9XX9p9tKymbcH+gXXi9g9c/9c",
	"patient_ref_no: pending, member-alt-key: none",
	"provider_npi 1234",
	"patients 12, subscribers: 40, PTSD 3",
];

for (const text of lookAlikes) {
	test(`no rule taints the look-alike: ${text}`, () =>
		run(
			Effect.gen(function* () {
				const { result } = yield* scanWith({ transcript: [user(text)] });

				expect(ScanResult.$is("Clean")(result)).toBe(true);
			}),
		));
}

for (const [rule, category, text] of [
	["labelled-device", "device", "com.northfield.etl.RecordRejectedException: record rejected: {device_serial=NG222"],
	["labelled-mrn", "mrn", "Patient: John Doe  MRN: 4417229"],
] as const) {
	test(`a labelled value taints whatever its digits or neighbors look like: ${text}`, () =>
		run(
			Effect.gen(function* () {
				const { result } = yield* scanWith({ transcript: [user(text)] });

				expect(result).toEqual(ruleTaint(rule, category));
			}),
		));
}

test("a labelled value cut off at the end of a turn taints, though the next turn goes on", () =>
	run(
		Effect.gen(function* () {
			const { result } = yield* scanWith({
				transcript: [tool("GET /notes/88 -> 500\nMRN: 4821"), assistant("The note failed to load. Retrying.")],
			});

			expect(result).toEqual(ruleTaint("labelled-mrn", "mrn"));
		}),
	));

for (const [after, files] of [
	["nothing", ""],
	["pi's list of files read", "\n\n<read-files>\nexports/rejected.csv\nsrc/import.ts\n</read-files>"],
]) {
	test(`a labelled value cut off at the end of a compaction summary taints, followed by ${after}`, () =>
		run(
			Effect.gen(function* () {
				const summary = user(
					`The conversation history before this point was compacted into the following summary:\n\n<summary>\nRejected rows so far: patient_driver_license: Q001${files}\n</summary>`,
				);

				const { result } = yield* scanWith({ transcript: [summary] });

				expect(result).toEqual(ruleTaint("labelled-license", "license"));
			}),
		));
}

test("a value under a patient-side label cut off at the end of a turn taints, though the next turn goes on", () =>
	run(
		Effect.gen(function* () {
			const { result } = yield* scanWith({
				transcript: [tool("GET /claims/88 -> 500\nmember_alt_key: NG2"), assistant("Retrying.")],
			});

			expect(result).toEqual(ruleTaint("labelled-patient-side", "other-id"));
		}),
	));

for (const text of ["MRN: 4821 was not found", "Rejected: DL: Q001"]) {
	test(`a short labelled value taints only after an unambiguous label at a turn's end: ${text}`, () =>
		run(
			Effect.gen(function* () {
				const { result } = yield* scanWith({ transcript: [tool(text)] });

				expect(ScanResult.$is("Clean")(result)).toBe(true);
			}),
		));
}

test("an SSN inside base64 text taints by rule", () =>
	run(
		Effect.gen(function* () {
			const encoded = Encoding.Base64.encode("Patient SSN 078-05-1120 on file");
			const { result } = yield* scanWith({ transcript: [tool(`{"note": "${encoded}"}`)] });

			expect(result).toEqual(ruleTaint("ssn", "ssn"));
		}),
	));

const gzip = (text: string) =>
	Effect.promise(() => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).bytes());

test("gzip written as hex of PHI text taints by rule", () =>
	run(
		Effect.gen(function* () {
			const compressed = yield* gzip("DOB: 03/14/1962");
			const { result } = yield* scanWith({ transcript: [tool(`blob ${Encoding.Hex.encode(compressed)}`)] });

			expect(result).toEqual(ruleTaint("labelled-date", "date"));
		}),
	));

test("the rules read the whole transcript, so a name cleared long ago and a phone that arrives later taint together", () =>
	run(
		Effect.gen(function* () {
			const first = [user("Patient: Marisol Quintero")];
			const cursor = yield* clearedCursor(first);
			const later = [...first, assistant("Noted."), user("call her back on (312) 847-2210")];
			const { result } = yield* scanWith({ transcript: later, cursor });

			expect(result).toEqual(ruleTaint("name-near-phone", "name"));
		}),
	));

const devText = Arr.join(
	[
		"export const scan = Effect.fn(function* (transcript: Transcript) { return yield* judge.ask(input); });",
		"2024-01-15T10:22:33.123Z INFO request_id=550e8400-e29b-41d4-a716-446655440000 GET /api/v2/orders?page=3 200 12ms",
		`SELECT id, created_at FROM orders WHERE customer_id = $1 AND status = 'open'; -- key ${Encoding.Base64.encode("0123456789abcdef0123456789abcdef")}`,
		'{"name": "phi-router", "version": "4.1.2", "integrity": "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="}',
		"diff --git a/features/policy/index.ts b/features/policy/index.ts\n@@ -1,4 +1,6 @@\n-const threshold = 0.3;\n+const threshold = 0.2;",
	],
	"\n",
);

const devTranscript = Arr.makeBy(400, (index) =>
	(index % 2 === 0 ? tool : assistant)(Str.repeat(Math.ceil(5000 / devText.length))(devText)),
);

test("a two-million-character transcript scans in well under a second", () =>
	run(
		Effect.gen(function* () {
			const [elapsed, { result }] = yield* Effect.timed(
				scanWith({ transcript: devTranscript, maxChars: 3_000_000 }),
			);

			expect(ScanResult.$is("Clean")(result) && result.stats.newChars).toBeGreaterThan(2_000_000);
			expect(elapsed.pipe(Duration.toMillis)).toBeLessThan(1000);
		}),
	));
