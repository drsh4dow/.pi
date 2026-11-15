import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Str from "effect/String";

import { compactJson, prettyJson } from "./encodings.ts";
import type { Random } from "./random.ts";
import { type Labelled, labelledValues, primaryOf, recordObject, type RenderInput, topicOf } from "./record.ts";
import { sqlString } from "./tabular.ts";

export const diffHeader = ({ rng, path }: { readonly rng: Random; readonly path: string }) => [
	`diff --git a/${path} b/${path}`,
	`index ${rng.hex(7)}..${rng.hex(7)} 100644`,
	`--- a/${path}`,
	`+++ b/${path}`,
];

const hunk = (context: Arr.NonEmptyReadonlyArray<string>, added: ReadonlyArray<string>) => [
	`@@ -1,${String(context.length)} +1,${String(context.length + added.length)} @@`,
	` ${Arr.headNonEmpty(context)}`,
	...Arr.map(added, (line) => `+${line}`),
	...Arr.map(Arr.tailNonEmpty(context), (line) => ` ${line}`),
];

const rowObject = (rowId: number, values: ReadonlyArray<Labelled>) => ({ id: rowId, ...recordObject(values) });

interface Fixture {
	readonly path: string;
	readonly context: Arr.NonEmptyReadonlyArray<string>;
	readonly added: (rowId: number, values: ReadonlyArray<Labelled>) => ReadonlyArray<string>;
}

const fixtures: Arr.NonEmptyReadonlyArray<Fixture> = [
	{
		path: "test/fixtures/claims.json",
		context: ["[", "  {", '    "id": 1,', '    "status": "pending"'],
		added: (rowId, values) => {
			const lines = Str.split("\n")(`${prettyJson(rowObject(rowId, values))},`);

			return Arr.map(lines, (line) => `  ${line}`);
		},
	},
	{
		path: "db/seeds/patients.yml",
		context: ["patients:", "  - id: 1", "    status: pending"],
		added: (rowId, values) => [
			`  - id: ${String(rowId)}`,
			...Arr.map(values, ({ key, value }) => `    ${key}: "${value}"`),
		],
	},
	{
		path: "db/seeds/002_claims.sql",
		context: ["-- seed data for local development", "INSERT INTO member_claims (id, status) VALUES (1, 'pending');"],
		added: (rowId, values) => {
			const columns = Arr.join(
				Arr.map(values, ({ key }) => key),
				", ",
			);

			const row = Arr.join(
				Arr.map(values, ({ value }) => sqlString(value)),
				", ",
			);

			return [`INSERT INTO member_claims (id, ${columns}) VALUES (${String(rowId)}, ${row});`];
		},
	},
];

export const gitDiff = ({ record, rng, minified }: RenderInput) => {
	const values = labelledValues(record);

	if (minified) {
		const path = "test/fixtures/claims.min.json";
		const row = compactJson([rowObject(record.rowId, values)]);

		return Arr.join(
			[...diffHeader({ rng, path }), "@@ -1 +1 @@", "-[]", `+${row}`, String.raw`\ No newline at end of file`],
			"\n",
		);
	}

	const { path, context, added } = rng.pick(fixtures);

	return Arr.join([...diffHeader({ rng, path }), ...hunk(context, added(record.rowId, values))], "\n");
};

const neighbours = [
	"claims_batch_0447.csv",
	"manifest.json",
	"remits/era_835_0447.txt",
	"README.txt",
	"eligibility/270_batch_0447.x12",
	"summary.xlsx",
];

export const fileName = ({ record, rng, minified }: RenderInput) => {
	const field = primaryOf(record);
	const root = `exports/2025-${rng.pick(["01", "02", "03", "04"])}`;
	const topic = topicOf(record);
	const document = rng.pick(["referral", "discharge-summary", "lab-results", "intake-form", "prior-auth"]);

	const phiPath =
		field.kind === "photo"
			? `${root}/photos/${topic}/${field.value}`
			: `${root}/${rng.pick(["referrals", "scans", "outbox"])}/${field.value}_${topic}_${document}.pdf`;

	const others = Arr.map(Arr.take(rng.shuffle(neighbours), 4), (name) => `${root}/${name}`);
	const listing = Arr.sort([...others, phiPath], Order.String);

	return minified ? compactJson({ files: listing }) : Arr.join(listing, "\n");
};
