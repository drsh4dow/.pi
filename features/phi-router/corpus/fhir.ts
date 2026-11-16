import * as Arr from "effect/Array";

import { compactJson, type JsonObject, prettyJson } from "./encodings.ts";
import type { TextIdentifier } from "./manifest.ts";
import { type RenderInput, uuid } from "./record.ts";

const v2Identifier = (code: string, system: string, value: string): JsonObject => ({
	type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code }] },
	system,
	value,
});

const telecom = (system: string, value: string): JsonObject => ({ telecom: [{ system, value, use: "home" }] });

interface Placement {
	readonly patient: JsonObject;
	readonly resources: ReadonlyArray<JsonObject>;
}

type Place = (value: string, patientRef: string) => Placement;

const inPatient =
	(build: (value: string) => JsonObject): Place =>
	(value) => ({ patient: build(value), resources: [] });

const isMbi = (value: string) => /^\d[A-Z]/u.test(value);

const placements = {
	"patient-name": inPatient((value) => ({ name: [{ use: "official", text: value }] })),
	"birth-date": inPatient((value) => ({ birthDate: value })),
	"street-address": inPatient((value) => ({ address: [{ use: "home", line: [value], country: "US" }] })),
	"personal-phone": inPatient((value) => telecom("phone", value)),
	"personal-email": inPatient((value) => telecom("email", value)),
	ssn: inPatient((value) => ({ identifier: [{ system: "http://hl7.org/fhir/sid/us-ssn", value }] })),
	mrn: inPatient((value) => ({ identifier: [v2Identifier("MR", "urn:oid:2.16.840.1.113883.3.4471.1", value)] })),
	"driver-license": inPatient((value) => ({
		identifier: [v2Identifier("DL", "urn:oid:2.16.840.1.113883.4.3.41", value)],
	})),
	passport: inPatient((value) => ({
		identifier: [v2Identifier("PPN", "http://hl7.org/fhir/sid/passport-USA", value)],
	})),
	"medicare-medicaid-number": inPatient((value) => ({
		identifier: [
			isMbi(value)
				? v2Identifier("MC", "http://hl7.org/fhir/sid/us-mbi", value)
				: v2Identifier("MA", "urn:oid:2.16.840.1.113883.4.927", value),
		],
	})),
	"member-number": (value, patientRef) => ({
		patient: {},
		resources: [
			{
				resourceType: "Coverage",
				status: "active",
				subscriberId: value,
				beneficiary: { reference: patientRef },
				payor: [{ display: "Cascade Mutual Health Plan" }],
			},
		],
	}),
} satisfies Record<TextIdentifier, Place>;

export const fhirJson = ({ record, rng, minified }: RenderInput) => {
	const { lang, diagnosis } = record;
	const patientId = uuid(rng);
	const patientRef = `urn:uuid:${patientId}`;
	const placed = Arr.map(record.fields, ({ kind, value }) => placements[kind](value, patientRef));
	const patient = Arr.reduce(placed, {}, (fields: JsonObject, placement) => ({ ...fields, ...placement.patient }));
	const resources = Arr.flatMap(placed, (placement) => placement.resources);

	const all: ReadonlyArray<JsonObject> = [
		{ resourceType: "Patient", id: patientId, ...patient, gender: rng.pick(["female", "male"]) },
		...resources,
		{
			resourceType: "Condition",
			clinicalStatus: {
				coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }],
			},
			code: {
				coding: [
					{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: diagnosis.code, display: diagnosis.text[lang] },
				],
			},
			subject: { reference: patientRef },
		},
		{
			resourceType: "MedicationStatement",
			status: "active",
			medicationCodeableConcept: { text: diagnosis.medication[lang] },
			subject: { reference: patientRef },
		},
	];

	const bundle: JsonObject = {
		resourceType: "Bundle",
		id: uuid(rng),
		type: rng.pick(["transaction", "collection"]),
		entry: Arr.map(all, (resource) => ({
			fullUrl: resource["resourceType"] === "Patient" ? patientRef : `urn:uuid:${uuid(rng)}`,
			resource,
		})),
	};

	return minified ? compactJson(bundle) : prettyJson(bundle);
};
