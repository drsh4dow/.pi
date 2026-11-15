import * as Arr from "effect/Array";

import type { SafeHarbor } from "../policy/index.ts";
import { compactJson, type JsonObject, prettyJson } from "./encodings.ts";
import { identifierLabels } from "./labels.ts";
import type { Lang } from "./people.ts";
import { primaryOf, type RenderInput, uuid } from "./record.ts";

const v2Identifier = (code: string, system: string, value: string): JsonObject => ({
	type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code }] },
	system,
	value,
});

const telecom = (system: string, value: string): JsonObject => ({ telecom: [{ system, value, use: "home" }] });

const extension = (url: string, key: string, value: string): JsonObject => ({
	extension: [{ url: `http://northfield-health.example/fhir/StructureDefinition/${url}`, [key]: value }],
});

interface Placement {
	readonly patient: JsonObject;
	readonly resources: ReadonlyArray<JsonObject>;
}

type Place = (value: string, patientRef: string, lang: Lang) => Placement;

const inPatient =
	(build: (value: string, lang: Lang) => JsonObject): Place =>
	(value, _patientRef, lang) => ({ patient: build(value, lang), resources: [] });

const beside =
	(build: (value: string, patientRef: string, lang: Lang) => JsonObject): Place =>
	(value, patientRef, lang) => ({ patient: {}, resources: [build(value, patientRef, lang)] });

const placements = {
	name: inPatient((value) => ({ name: [{ use: "official", text: value }] })),
	geographic: inPatient((value) =>
		/^\d{5}-\d{4}$/u.test(value)
			? { address: [{ use: "home", postalCode: value, country: "US" }] }
			: { address: [{ use: "home", line: [value], country: "US" }] },
	),
	date: inPatient((value) => ({ birthDate: value })),
	phone: inPatient((value) => telecom("phone", value)),
	fax: inPatient((value) => telecom("fax", value)),
	email: inPatient((value) => telecom("email", value)),
	url: inPatient((value) => telecom("url", value)),
	ssn: inPatient((value) => ({ identifier: [{ system: "http://hl7.org/fhir/sid/us-ssn", value }] })),
	mrn: inPatient((value) => ({ identifier: [v2Identifier("MR", "urn:oid:2.16.840.1.113883.3.4471.1", value)] })),
	license: inPatient((value) => ({ identifier: [v2Identifier("DL", "urn:oid:2.16.840.1.113883.4.3.41", value)] })),
	vehicle: inPatient((value) => extension("vehicle-vin", "valueString", value)),
	biometric: inPatient((value) => extension("fingerprint-template", "valueBase64Binary", value)),
	photo: inPatient((value, lang) => ({
		photo: [{ contentType: "image/png", title: value }],
		...extension("photo-caption", "valueString", identifierLabels.photo[lang]),
	})),
	"health-plan": beside((value, patientRef) => ({
		resourceType: "Coverage",
		status: "active",
		subscriberId: value,
		beneficiary: { reference: patientRef },
		payor: [{ display: "Cascade Mutual Health Plan" }],
	})),
	account: beside((value, patientRef) => ({
		resourceType: "Account",
		status: "active",
		identifier: [{ system: "urn:oid:2.16.840.1.113883.3.4471.2", value }],
		subject: [{ reference: patientRef }],
	})),
	device: beside((value, patientRef) => ({
		resourceType: "Device",
		serialNumber: value,
		type: { text: "Implantable cardiac pacemaker" },
		patient: { reference: patientRef },
	})),
	ip: beside((value, patientRef) => ({
		resourceType: "AuditEvent",
		action: "R",
		agent: [{ requestor: true, network: { address: value, type: "2" } }],
		entity: [{ what: { reference: patientRef } }],
	})),
	"other-id": beside((value, patientRef) => ({
		resourceType: "MedicationRequest",
		identifier: [{ system: "urn:oid:2.16.840.1.113883.3.4471.6", value }],
		status: "active",
		intent: "order",
		subject: { reference: patientRef },
	})),
} satisfies Record<SafeHarbor, Place>;

/** A FHIR R4 Bundle: a Patient holding or pointing at the identifier, its Condition, and its medication. */
export const fhirJson = ({ record, rng, minified }: RenderInput) => {
	const { lang, diagnosis } = record;
	const patientId = uuid(rng);
	const patientRef = `urn:uuid:${patientId}`;
	const field = primaryOf(record);
	const { patient, resources } = placements[field.kind](field.value, patientRef, lang);

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
