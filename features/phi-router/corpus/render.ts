/** The engine eval's report as text: one window in full, or a sweep as one row per window. */
import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Report } from "./report.ts";

interface Table {
	readonly header: ReadonlyArray<string>;
	readonly labels: number;
	readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

const table = ({ header, labels, rows }: Table) => {
	const widths = Arr.map(header, (title, column) =>
		Math.max(title.length, ...Arr.map(rows, (row) => (row[column] ?? "").length)),
	);

	const cellOf = (cell: string, column: number) => {
		const width = widths[column] ?? 0;

		return column < labels ? Str.padEnd(width)(cell) : Str.padStart(width)(cell);
	};

	const line = (row: ReadonlyArray<string>) => Str.trimEnd(Arr.join(Arr.map(row, cellOf), "  "));

	return Arr.join(Arr.map([header, ...rows], line), "\n");
};

const dollars = (cost: number) => `$${cost.toFixed(4)}`;

const inPolicyCases = ({ strata }: Report) =>
	Arr.reduce(
		Arr.filter(strata, ({ axis }) => axis === "identifier"),
		0,
		(total, { cases }) => total + cases,
	);

const overRouted = ({ overRouting }: Report) => ({
	cases: Arr.reduce(overRouting, 0, (total, row) => total + row.cases),
	overRouted: Arr.reduce(overRouting, 0, (total, row) => total + row.overRouted),
	requests: Arr.reduce(overRouting, 0, (total, row) => total + row.requests),
	onEnt: Arr.reduce(overRouting, 0, (total, row) => total + row.onEnt),
});

const leakTable = ({ leaks }: Report) =>
	leaks.length === 0
		? "Leaked cases: none"
		: table({
				header: ["leaked case", "identifier", "carrier", "transform", "entry", "request"],
				labels: 5,
				rows: Arr.map(leaks, ({ id, strata, request }) => [
					id,
					strata.identifier,
					strata.carrier,
					strata.transform,
					strata.entry,
					String(request),
				]),
			});

const strataTable = ({ strata }: Report) =>
	table({
		header: ["axis", "value", "N", "leaks", "upper95"],
		labels: 2,
		rows: Arr.map(strata, (row) => [
			row.axis,
			row.value,
			String(row.cases),
			String(row.leaks),
			row.leakRateUpper95.toFixed(4),
		]),
	});

const overRoutingTable = (report: Report) => {
	const clean = overRouted(report);

	const rows = Arr.map(report.overRouting, (row) => [
		row.negative,
		String(row.cases),
		String(row.overRouted),
		String(row.requests),
		String(row.onEnt),
	]);

	return table({
		header: ["negative", "N", "over-routed", "requests", "on ent"],
		labels: 1,
		rows: [
			...rows,
			["all", String(clean.cases), String(clean.overRouted), String(clean.requests), String(clean.onEnt)],
		],
	});
};

const render = (report: Report) => {
	const { judge, lanes, fragments } = report;

	return Arr.join(
		[
			`Judge window ${String(report.window)}. In-policy positive cases whose complete canary reached a personal account, with the one-sided Clopper-Pearson 95% upper bound`,
			strataTable(report),
			"",
			leakTable(report),
			"",
			"Over-routing: clean cases with any request on ent, and clean requests on ent",
			overRoutingTable(report),
			"",
			`in-policy positive cases ${String(inPolicyCases(report))}: leaked ${String(report.leaks.length)}`,
			`fragments: ${String(fragments.cases)} cases showed a personal account ${String(fragments.shown)} fragments or split parts, none a leak`,
			`requests: personal ${String(lanes.personal)}, ent ${String(lanes.ent)}`,
			`judge calls ${String(judge.calls)}, input tokens ${String(judge.inputTokens)}, cost ${dollars(judge.cost)}, pieces sealed by a judge failure ${String(judge.failures)}`,
		],
		"\n",
	);
};

const sweepTable = (reports: ReadonlyArray<Report>) =>
	table({
		header: ["window", "leaks", "over-routed cases", "clean requests on ent", "judge calls", "input tokens", "cost"],
		labels: 0,
		rows: Arr.map(reports, (report) => {
			const clean = overRouted(report);

			return [
				String(report.window),
				String(report.leaks.length),
				`${String(clean.overRouted)}/${String(clean.cases)}`,
				`${String(clean.onEnt)}/${String(clean.requests)}`,
				String(report.judge.calls),
				String(report.judge.inputTokens),
				dollars(report.judge.cost),
			];
		}),
	});

/** The sweep table and the leak list of each size that leaked, or the full report of one window. */
export const outputOf = (reports: ReadonlyArray<Report>) => {
	if (reports.length === 1) {
		return Arr.join(Arr.map(reports, render), "\n\n");
	}

	const leaking = Arr.filter(reports, (report) => report.leaks.length > 0);

	return Arr.join([sweepTable(reports), ...Arr.map(leaking, leakTable)], "\n\n");
};
