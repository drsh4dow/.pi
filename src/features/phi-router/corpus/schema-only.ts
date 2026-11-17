import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Sample } from "./conversation.ts";
import type { Random } from "./random.ts";

interface Column {
	readonly name: string;
	readonly camel: string;
	readonly sql: string;
	readonly kind: "text" | "date";
	readonly required: boolean;
}

const column = (name: string, camel: string, sql: string, required: boolean): Column => ({
	name,
	camel,
	sql: required ? `${sql} NOT NULL` : sql,
	kind: Str.startsWith("date")(sql) || Str.startsWith("timestamp")(sql) ? "date" : "text",
	required,
});

const columns: Arr.NonEmptyReadonlyArray<Column> = [
	column("first_name", "firstName", "varchar(100)", true),
	column("last_name", "lastName", "varchar(100)", true),
	column("date_of_birth", "dateOfBirth", "date", true),
	column("ssn", "ssn", "char(11)", false),
	column("mrn", "mrn", "varchar(20)", true),
	column("medicare_beneficiary_id", "medicareBeneficiaryId", "char(11)", false),
	column("member_id", "memberId", "varchar(30)", false),
	column("phone", "phone", "varchar(20)", false),
	column("email", "email", "varchar(254)", false),
	column("street_address", "streetAddress", "text", false),
	column("postal_code", "postalCode", "varchar(10)", false),
	column("diagnosis_code", "diagnosisCode", "varchar(8)", false),
	column("primary_diagnosis", "primaryDiagnosis", "text", false),
	column("medication", "medication", "text", false),
	column("admit_date", "admitDate", "timestamptz", false),
	column("discharge_date", "dischargeDate", "timestamptz", false),
	column("drivers_license", "driversLicense", "varchar(20)", false),
	column("insurance_plan_id", "insurancePlanId", "varchar(30)", false),
];

const tables: Arr.NonEmptyReadonlyArray<string> = [
	"patients",
	"members",
	"encounters",
	"claim_subscribers",
	"referrals",
];

const pickColumns = (rng: Random) => Arr.take(rng.shuffle(columns), rng.between(6, 11));

const ddl = (rng: Random): Sample => {
	const table = rng.pick(tables);

	const lines = Arr.map(pickColumns(rng), ({ name, sql }) => `  ${name} ${sql},`);

	return {
		scene: {
			asks: [
				"Review this table before I run the migration. Anything missing for HIPAA?",
				"Should any of these columns be encrypted at rest?",
			],
			commands: [`pg_dump --schema-only -t ${table} intake_dev`],
			paths: [`db/schema/${table}.sql`],
		},
		payload: Arr.join(
			[
				`CREATE TABLE ${table} (`,
				"  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),",
				...lines,
				"  created_at timestamptz NOT NULL DEFAULT now()",
				");",
				`CREATE INDEX ${table}_created_at_idx ON ${table} (created_at);`,
			],
			"\n",
		),
	};
};

const prisma = (rng: Random): Sample => {
	const model = rng.pick(["Patient", "Member", "Subscriber", "Enrollee"]);

	const fields = Arr.map(
		pickColumns(rng),
		({ name, camel, kind, required }) =>
			`  ${Str.padEnd(22)(camel)} ${kind === "date" ? "DateTime" : "String"}${required ? "" : "?"} @map("${name}")`,
	);

	return {
		scene: {
			asks: [
				"Prisma complains about this model after the rename. What did I miss?",
				"Can you add an index for lookups on this model?",
			],
			commands: ["npx prisma validate"],
			paths: ["prisma/schema.prisma"],
		},
		payload: Arr.join(
			[
				`model ${model} {`,
				"  id                     String   @id @default(uuid())",
				...fields,
				`  @@map("${Str.toLowerCase(model)}s")`,
				"}",
			],
			"\n",
		),
	};
};

const validator = (rng: Random): Sample => ({
	scene: {
		asks: [
			"The intake form validator lets bad input through. Can you tighten these patterns?",
			"Write tests for this validator.",
		],
		commands: ["sed -n '1,60p' src/intake/validate.ts"],
		paths: ["src/intake/validate.ts"],
	},
	payload: Arr.join(
		[
			'import { z } from "zod";',
			"",
			"export const PatientIntake = z.object({",
			"  firstName: z.string().min(1).max(100),",
			"  lastName: z.string().min(1).max(100),",
			String.raw`  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),`,
			String.raw`  ssn: z.string().regex(/^\d{3}-\d{2}-\d{4}$/, "format ###-##-####").optional(),`,
			String.raw`  mbi: z.string().regex(/^[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y]{2}\d{2}$/).optional(),`,
			String.raw`  phone: z.string().regex(/^\(?\d{3}\)?[ -]?\d{3}-\d{4}$/),`,
			"  email: z.string().email(),",
			String.raw`  diagnosisCode: z.string().regex(/^[A-TV-Z]\d{2}(\.\w{1,4})?$/).array().max(${String(rng.between(4, 12))}),`,
			"});",
		],
		"\n",
	),
});

const migration = (rng: Random): Sample => {
	const table = rng.pick(tables);
	const { name, kind } = rng.pick(columns);
	const revision = rng.hex(12);

	return {
		scene: {
			asks: [
				"Alembic says the head is diverged after this migration. Can you fix the chain?",
				"Does this downgrade path lose data?",
			],
			commands: ["alembic history --verbose | head -40"],
			paths: [`migrations/versions/${revision}_add_${name}.py`],
		},
		payload: Arr.join(
			[
				`"""add ${name} to ${table}`,
				"",
				`Revision ID: ${revision}`,
				`Revises: ${rng.hex(12)}`,
				'"""',
				"from alembic import op",
				"import sqlalchemy as sa",
				"",
				"def upgrade():",
				`    op.add_column("${table}", sa.Column("${name}", sa.${kind === "date" ? "DateTime()" : "String()"}, nullable=True))`,
				`    op.create_index("ix_${table}_${name}", "${table}", ["${name}"])`,
				"",
				"def downgrade():",
				`    op.drop_index("ix_${table}_${name}", table_name="${table}")`,
				`    op.drop_column("${table}", "${name}")`,
			],
			"\n",
		),
	};
};

const segmentMap = (rng: Random): Sample => ({
	scene: {
		asks: [
			"Our HL7 mapping doc is out of date. Can you check it against the parser?",
			"Generate TypeScript types from this mapping table.",
		],
		commands: ["cat docs/interfaces/adt-mapping.md"],
		paths: ["docs/interfaces/adt-mapping.md"],
	},
	payload: Arr.join(
		[
			"| Segment field | Meaning | Target column |",
			"| --- | --- | --- |",
			...Arr.take(
				rng.shuffle([
					"| PID-3 | Patient identifier list (MRN, CX type MR) | patients.mrn |",
					"| PID-5 | Patient name (XPN) | patients.last_name, patients.first_name |",
					"| PID-7 | Date/time of birth | patients.date_of_birth |",
					"| PID-11 | Patient address (XAD) | patients.street_address |",
					"| PID-13 | Home phone (XTN) | patients.phone |",
					"| PID-19 | SSN number, patient | patients.ssn |",
					"| PV1-44 | Admit date/time | encounters.admit_date |",
					"| DG1-3 | Diagnosis code (CWE, ICD-10-CM) | encounters.diagnosis_code |",
					"| IN1-36 | Policy number | coverage.member_id |",
				]),
				rng.between(5, 9),
			),
		],
		"\n",
	),
});

const emptyExport = (rng: Random): Sample => {
	const header = Arr.map(pickColumns(rng), ({ name }) => name);

	return {
		scene: {
			asks: ["The export job writes only the header. Why are there no rows?", "Why is the nightly extract empty?"],
			commands: [`head -5 exports/${rng.pick(tables)}_extract.csv && wc -l exports/*.csv`],
			paths: [`exports/${rng.pick(tables)}_extract.csv`],
		},
		payload: `${Arr.join(["record_id", ...header], ",")}\n`,
	};
};

const sqlalchemy = (rng: Random): Sample => {
	const fields = Arr.map(
		pickColumns(rng),
		({ name, kind, required }) =>
			`    ${name} = Column(${kind === "date" ? "DateTime" : "String"}, nullable=${required ? "False" : "True"})`,
	);

	return {
		scene: {
			asks: [
				"Convert this SQLAlchemy model to the 2.0 typed style.",
				"Mark which of these columns need the encrypted type.",
			],
			commands: ["sed -n '1,40p' app/models/patient.py"],
			paths: ["app/models/patient.py"],
		},
		payload: Arr.join(
			[
				"class Patient(Base):",
				'    __tablename__ = "patients"',
				"",
				"    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)",
				...fields,
			],
			"\n",
		),
	};
};

export const schemaOnly: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	ddl,
	prisma,
	validator,
	migration,
	segmentMap,
	emptyExport,
	sqlalchemy,
];
