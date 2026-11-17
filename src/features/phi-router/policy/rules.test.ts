import { expect, test } from "bun:test";

import * as Option from "effect/Option";

import { firstHit, type RuleId } from "./rules.ts";

const msh = String.raw`MSH|^~\&|EPIC|HOSP|||20240105||ADT^A01|1|P|2.5`;

const isa =
	"ISA*00*          *00*          *ZZ*SUBMITTER      *ZZ*PAYER          *240105*1200*^*00501*000000001*0*P*:~";

const header = `${isa}GS*HC*SUBMITTER*PAYER*20240105*1200*1*X*005010X222A1~ST*837*0001*005010X222A1~`;

const fires: ReadonlyArray<readonly [RuleId, string]> = [
	["ssn", "Patient SSN 078-05-1120 on file"],
	["mbi", "Medicare beneficiary 3WR7-KX2-PN45 was billed twice"],
	["mbi", "mbi=3WR7KX2PN45"],
	["hl7-pid", `${msh}\rPID|1||00482913^^^MRN||QUINTERO^MARISOL||19620314|F`],
	["hl7-pid", `${msh}\rPID|1||00482913^^^MRN||^^||19620314|F`],
	["hl7-pid", String.raw`{"hl7": "${msh}\rPID|1||||QUINTERO^MARISOL"}`],
	[
		"fhir-patient",
		'{"resourceType": "Patient", "id": "8812", "name": [{"family": "Quintero", "given": ["Marisol"]}]}',
	],
	["fhir-patient", '{"resourceType": "Patient", "id": "8812", "birthDate": "1962-03-14"}'],
	[
		"fhir-patient",
		'{"resourceType": "Patient", "identifier": [{"system": "http://hl7.org/fhir/sid/us-ssn", "value": "078051120"}]}',
	],
	[
		"fhir-patient",
		'{"resourceType": "Patient", "identifier": [{"value": "XGH492817305", "system": "https://payer.example/member-id"}]}',
	],
	["x12-member", `${header}NM1*IL*1*QUINTERO*MARISOL****MI*XGH492817305~`],
	["x12-member", `${header}NM1*QC*1******MI*XGH492817305~`],
];

for (const [rule, text] of fires) {
	test(`${rule} fires on ${text}`, () => {
		expect(Option.map(firstHit(text), (hit) => hit.rule)).toEqual(Option.some(rule));
	});
}

const silent: ReadonlyArray<string> = [
	"impossible SSNs 000-12-3456, 666-12-3456, 912-56-7823, 412-00-3456 and 412-56-0000",
	"ssn 078051120 has no dashes, and 1078-05-1120 is not one",
	"a digit where a letter belongs: 37R7-KX2-PN45, and an excluded S: 3SR7-KX2-PN45",
	`${msh}\rPID|1||00482913^^^MRN||||`,
	`${msh}\rPID|1||00482913^^^MRN||^^||`,
	'{"resourceType": "Observation", "subject": {"reference": "Patient/123"}, "valueQuantity": {"value": 7.2}}',
	'{"resourceType": "Patient", "id": "8812", "identifier": [{"system": "https://acme.example/patient-id", "value": "4471"}]}',
	'{"entry": [{"resource": {"resourceType": "Patient", "id": "8812"}}, {"resource": {"resourceType": "Practitioner", "name": [{"family": "Okafor"}]}}]}',
	header,
	`${header}NM1*IL*1~`,
	`${header}NM1*85*2*NORTHFIELD CLINIC*****XX*1234567893~`,
];

for (const text of silent) {
	test(`no rule fires on ${text}`, () => {
		expect(firstHit(text)).toEqual(Option.none());
	});
}
