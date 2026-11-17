import * as Arr from "effect/Array";
import * as Str from "effect/String";

import { compactJson } from "./encodings.ts";
import type { ByLang } from "./people.ts";
import { labelledValues, recordObject, type RenderInput } from "./record.ts";

const tables = {
	en: ["member_claims", "patient_intake", "encounter_staging", "billing_export", "referral_queue"],
	es: ["pacientes_ingreso", "reclamos_afiliados", "citas_pendientes"],
	de: ["patienten_aufnahme", "abrechnung_export", "ueberweisungen"],
	fr: ["dossiers_patients", "demandes_remboursement", "admissions"],
	pt: ["atendimentos_pacientes", "guias_faturamento", "internacoes"],
	vi: ["benh_nhan_kham", "ho_so_thanh_toan", "luot_nhap_vien"],
} satisfies ByLang<Arr.NonEmptyReadonlyArray<string>>;

export const sqlString = (value: string) => `'${Str.replaceAll("'", "''")(value)}'`;

const pgDump = (table: string, columns: ReadonlyArray<string>, row: ReadonlyArray<string>) =>
	Arr.join(
		[
			"--",
			"-- PostgreSQL database dump",
			"--",
			"",
			"-- Dumped from database version 15.6",
			"-- Dumped by pg_dump version 15.6",
			"",
			"SET statement_timeout = 0;",
			"SET client_encoding = 'UTF8';",
			"SET standard_conforming_strings = on;",
			"",
			`COPY public.${table} (${Arr.join(columns, ", ")}) FROM stdin;`,
			Arr.join(row, "\t"),
			String.raw`\.`,
			"",
		],
		"\n",
	);

const mysqlDump = (table: string, columns: ReadonlyArray<string>, row: ReadonlyArray<string>) =>
	Arr.join(
		[
			"-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)",
			"--",
			`-- Table structure for table \`${table}\``,
			"--",
			"",
			`DROP TABLE IF EXISTS \`${table}\`;`,
			`CREATE TABLE \`${table}\` (`,
			"  `id` bigint NOT NULL AUTO_INCREMENT,",
			...Arr.map(Arr.drop(columns, 1), (column) => `  \`${column}\` varchar(255) DEFAULT NULL,`),
			"  PRIMARY KEY (`id`)",
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
			"",
			`INSERT INTO \`${table}\` VALUES (${Arr.join(row, ",")});`,
			"",
		],
		"\n",
	);

export const sqlDump = ({ record, rng, minified }: RenderInput) => {
	const values = labelledValues(record);
	const table = rng.pick(tables[record.lang]);
	const columns = ["id", ...Arr.map(values, ({ key }) => key)];
	const quoted = [String(record.rowId), ...Arr.map(values, ({ value }) => sqlString(value))];

	if (minified) {
		const columnList = Arr.join(
			Arr.map(columns, (column) => `\`${column}\``),
			",",
		);

		return `/*!40101 SET NAMES utf8mb4 */;LOCK TABLES \`${table}\` WRITE;INSERT INTO \`${table}\` (${columnList}) VALUES (${Arr.join(quoted, ",")});UNLOCK TABLES;`;
	}

	return rng.chance(0.5)
		? pgDump(table, columns, [String(record.rowId), ...Arr.map(values, ({ value }) => value)])
		: mysqlDump(table, columns, quoted);
};

const csvField = (value: string) => (/[",\n]/u.test(value) ? `"${Str.replaceAll('"', '""')(value)}"` : value);

export const csv = ({ record, rng, minified }: RenderInput) => {
	const values = labelledValues(record);

	if (minified) {
		return compactJson([{ id: record.rowId, ...recordObject(values) }]);
	}

	const separator = rng.chance(0.2) ? ";" : ",";
	const header = Arr.join(["id", ...Arr.map(values, ({ key }) => key)], separator);
	const row = Arr.join([String(record.rowId), ...Arr.map(values, ({ value }) => csvField(value))], separator);

	return `${header}\n${row}\n`;
};
