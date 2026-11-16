import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Sample } from "./conversation.ts";
import { prettyJson } from "./encodings.ts";
import { diagnoses } from "./health.ts";
import type { Random } from "./random.ts";
import { two } from "./record.ts";

const byDiagnosis = (rng: Random): Sample => {
	const rows = Arr.map(Arr.take(rng.shuffle(diagnoses), rng.between(4, 7)), ({ code, text }) =>
		Arr.join([Str.padEnd(8)(code), Str.padEnd(48)(text.en), String(rng.between(3, 900))], " | "),
	);

	return {
		scene: {
			asks: ["These totals look low for March. Is the query double-filtering?", "Why is this report missing a row?"],
			commands: [
				`psql -c "select dx_code, dx_text, count(distinct patient_id) as patients from claims where month = '2025-03' group by 1, 2"`,
			],
			paths: ["reports/dx_counts_2025_03.txt"],
		},
		payload: Arr.join(
			[
				"dx_code  | dx_text                                          | patients",
				"---------+--------------------------------------------------+---------",
				...rows,
				`(${String(rows.length)} rows)`,
			],
			"\n",
		),
	};
};

const monthlyTotals = (rng: Random): Sample => ({
	scene: {
		asks: ["The dashboard and this export disagree on February. Which is right?", "Add a denial rate column."],
		commands: ["cat exports/monthly_totals.csv"],
		paths: ["exports/monthly_totals.csv"],
	},
	payload: Arr.join(
		[
			"month,claims,denied,paid_total_usd",
			...Arr.makeBy(rng.between(3, 6), (index) => {
				const claims = rng.between(4000, 15_000);

				return `2025-${two(index + 1)},${String(claims)},${String(rng.between(100, 900))},${String(claims * rng.between(90, 240))}.${rng.digits(2)}`;
			}),
		],
		"\n",
	),
});

const metrics = (rng: Random): Sample => ({
	scene: {
		asks: ["Is this metrics payload what the Grafana panel expects?", "Why is the denial rate a string here?"],
		commands: ["curl -s http://localhost:8080/internal/metrics/claims"],
		paths: ["tmp/metrics.json"],
	},
	payload: prettyJson({
		activeMembers: rng.between(9000, 40_000),
		claimsToday: rng.between(100, 900),
		deniedToday: rng.between(5, 90),
		denialRate: `0.0${rng.digits(2)}`,
		openPriorAuths: rng.between(10, 300),
	}),
});

const importSummary = (rng: Random): Sample => {
	const read = rng.between(5000, 20_000);
	const rejected = rng.between(5, 60);
	const duplicates = rng.between(0, rejected);

	return {
		scene: {
			asks: ["Is a reject count like this normal for the nightly import?", "Where do the schema rejects come from?"],
			commands: ["tail -n 3 logs/import/nightly.log"],
			paths: ["logs/import/nightly.log"],
		},
		payload: Arr.join(
			[
				`import started file=eligibility_2025030${String(rng.between(1, 9))}.csv`,
				`import finished rows_read=${String(read)} loaded=${String(read - rejected)} rejected=${String(rejected)}`,
				`rejects: duplicate=${String(duplicates)} schema=${String(rejected - duplicates)}`,
			],
			"\n",
		),
	};
};

/** Counts and totals over patients, with no one in them. */
export const counts: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	byDiagnosis,
	monthlyTotals,
	metrics,
	importSummary,
];
