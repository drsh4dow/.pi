import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Str from "effect/String";

import { compactJson } from "./encodings.ts";
import { phrases } from "./labels.ts";
import type { Random } from "./random.ts";
import { type Labelled, labelledValues, recordObject, type RenderInput, systemTime } from "./record.ts";

const services: Arr.NonEmptyReadonlyArray<string> = [
	"claims-worker",
	"etl-loader",
	"eligibility-sync",
	"billing-export",
	"intake-api",
];

const keyValue = ({ key, value }: Labelled) => (/[\s"=]/u.test(value) ? `${key}="${value}"` : `${key}=${value}`);

const burst = (rng: Random, count: number) => {
	const second = Str.slice(0, 20)(systemTime(rng));
	const draws = Arr.makeBy(count, () => rng.between(0, 999));
	const millis = Arr.sort(draws, Order.Number);

	return Arr.map(millis, (milli) => `${second}${Str.padStart(3, "0")(String(milli))}Z`);
};

export const logLine = ({ record, rng, minified }: RenderInput) => {
	const service = rng.pick(services);
	const values = labelledValues(record);
	const batch = rng.digits(5);
	const rejected = phrases.rejected[record.lang];
	const [start, retry, failure, commit] = burst(rng, 4);

	const lines = [
		{ ts: start, level: "INFO", msg: `consumer started topic=claims.inbound partition=${String(rng.int(12))}` },
		{ ts: retry, level: "WARN", msg: `retrying batch=${batch} attempt=2 reason=upstream_timeout` },
		{ ts: failure, level: "ERROR", msg: `${rejected}: ${Arr.join(Arr.map(values, keyValue), " ")}` },
		{ ts: commit, level: "INFO", msg: `batch=${batch} committed ok=${String(rng.between(40, 400))} failed=1` },
	];

	if (minified) {
		return Arr.join(
			Arr.map(lines, ({ ts, level, msg }) =>
				compactJson(
					level === "ERROR"
						? { ts: ts ?? "", level: "error", service, msg: rejected, record: recordObject(values) }
						: { ts: ts ?? "", level: Str.toLowerCase(level), service, msg },
				),
			),
			"\n",
		);
	}

	return Arr.join(
		Arr.map(lines, ({ ts, level, msg }) => `${ts ?? ""} ${Str.padEnd(5)(level)} ${service} ${msg}`),
		"\n",
	);
};

const javaTrace = (message: string, values: ReadonlyArray<Labelled>) =>
	Arr.join(
		[
			`com.northfield.etl.RecordRejectedException: ${message}: {${Arr.join(
				Arr.map(values, ({ key, value }) => `${key}=${value}`),
				", ",
			)}}`,
			"\tat com.northfield.etl.ClaimMapper.map(ClaimMapper.java:142)",
			"\tat com.northfield.etl.BatchRunner.lambda$run$0(BatchRunner.java:88)",
			"\tat java.base/java.util.stream.ReferencePipeline$3$1.accept(ReferencePipeline.java:197)",
			"\tat com.northfield.etl.BatchRunner.run(BatchRunner.java:91)",
			"\tat java.base/java.lang.Thread.run(Thread.java:1583)",
		],
		"\n",
	);

const pythonTrace = (message: string, values: ReadonlyArray<Labelled>) =>
	Arr.join(
		[
			"Traceback (most recent call last):",
			'  File "/app/etl/pipeline.py", line 211, in run',
			"    rows = [mapper.map_row(row) for row in batch]",
			'  File "/app/etl/mapper.py", line 88, in map_row',
			"    raise RecordRejected(row)",
			`etl.errors.RecordRejected: ${message}: {${Arr.join(
				Arr.map(values, ({ key, value }) => `'${key}': '${value}'`),
				", ",
			)}}`,
		],
		"\n",
	);

const nodeTrace = (message: string, values: ReadonlyArray<Labelled>) =>
	Arr.join(
		[
			`Error: ${message}: ${compactJson(recordObject(values))}`,
			"    at mapRow (/srv/app/dist/mapper.js:142:11)",
			"    at Array.map (<anonymous>)",
			"    at processBatch (/srv/app/dist/worker.js:57:24)",
			"    at async Consumer.run (/srv/app/dist/consumer.js:31:7)",
		],
		"\n",
	);

interface Trace {
	readonly type: string;
	readonly write: (message: string, values: ReadonlyArray<Labelled>) => string;
}

const traces: Arr.NonEmptyReadonlyArray<Trace> = [
	{ type: "RecordRejectedException", write: javaTrace },
	{ type: "RecordRejected", write: pythonTrace },
	{ type: "Error", write: nodeTrace },
];

export const stackTrace = ({ record, rng, minified }: RenderInput) => {
	const { type, write } = rng.pick(traces);
	const message = phrases.rejected[record.lang];
	const trace = write(message, labelledValues(record));

	return minified ? compactJson({ error: { type, message, stack: trace } }) : trace;
};
