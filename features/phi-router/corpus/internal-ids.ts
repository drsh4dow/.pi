import * as Arr from "effect/Array";
import * as Str from "effect/String";

import { carriers } from "./carriers.ts";
import type { Sample } from "./conversation.ts";
import { prettyJson } from "./encodings.ts";
import { diagnoses } from "./health.ts";
import type { TextCarrier } from "./manifest.ts";
import type { Random } from "./random.ts";
import { systemTime, uuid } from "./record.ts";

export const patientId = (rng: Random) => String(rng.between(1000, 99_999));

const clientCode = (rng: Random) => `NFH-${rng.digits(4)}`;

const syncQueue = (rng: Random): Sample => {
	const rows = Arr.makeBy(rng.between(4, 7), () =>
		Arr.join(
			[
				Str.padStart(10)(patientId(rng)),
				clientCode(rng),
				Str.padEnd(8)(rng.pick(["pending", "failed", "retry"])),
				Str.slice(0, 19)(systemTime(rng)),
				String(rng.between(1, 6)),
			],
			" | ",
		),
	);

	return {
		scene: {
			asks: [
				"The nightly sync skips some patients. Why do these rows never leave the queue?",
				"Which of these sync rows should the retry job pick up?",
			],
			commands: [
				`psql -c "select patient_id, client_code, sync_status, updated_at, attempts from sync_queue where sync_status <> 'done'"`,
			],
			paths: ["tmp/sync_queue.txt"],
		},
		payload: Arr.join(
			[
				"patient_id | client_code | sync_status | updated_at          | attempts",
				"-----------+-------------+-------------+---------------------+---------",
				...rows,
				`(${String(rows.length)} rows)`,
			],
			"\n",
		),
	};
};

const apiPayload = (rng: Random): Sample => ({
	scene: {
		asks: ["The enrollment API returns 409 for this request body. What conflicts?", "Is this request body valid?"],
		commands: ["cat tmp/last_request.json"],
		paths: ["tmp/last_request.json"],
	},
	payload: prettyJson({
		requestId: uuid(rng),
		patientId: uuid(rng),
		clientCode: clientCode(rng),
		episodeId: Number(rng.digits(6)),
		rowVersion: rng.between(1, 40),
		action: rng.pick(["enroll", "transfer", "disenroll"]),
		effective: "2025-04-01",
	}),
});

const workerLog = (rng: Random): Sample => ({
	scene: {
		asks: ["Why does the sync worker keep failing at step 3?", "Which patient ids hit the timeout?"],
		commands: ["kubectl logs deploy/sync-worker --since=30m | grep patient_id"],
		paths: ["logs/sync-worker.log"],
	},
	payload: Arr.join(
		Arr.makeBy(
			rng.between(3, 6),
			() =>
				`${systemTime(rng)} sync patient_id=${patientId(rng)} client=${clientCode(rng)} step=${String(rng.between(1, 5))}/5 status=${rng.pick(["ok", "failed", "retrying"])} trace=${rng.hex(16)}`,
		),
		"\n",
	),
});

const migration = (rng: Random): Sample => {
	const ids = Arr.makeBy(rng.between(3, 8), () => patientId(rng));

	return {
		scene: {
			asks: ["Review this backfill before I run it on prod.", "Will this migration lock the enrollments table?"],
			commands: ["cat db/migrations/0118_backfill_inactive.sql"],
			paths: ["db/migrations/0118_backfill_inactive.sql"],
		},
		payload: Arr.join(
			[
				"BEGIN;",
				`UPDATE enrollments SET status = 'inactive', updated_by = 'backfill-0118' WHERE patient_id IN (${Arr.join(ids, ", ")});`,
				`DELETE FROM sync_queue WHERE client_code = '${clientCode(rng)}' AND attempts > 5;`,
				"COMMIT;",
			],
			"\n",
		),
	};
};

export const internalIds: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	syncQueue,
	apiPayload,
	workerLog,
	migration,
];

/** Every text carrier but the 837, which cannot leave out the subscriber's name and member id. */
const internalOnly: Arr.NonEmptyReadonlyArray<TextCarrier> = [
	"sql-dump",
	"csv",
	"fhir-json",
	"hl7v2",
	"log-line",
	"stack-trace",
	"clinical-note",
	"ticket",
	"git-diff",
	"file-name",
];

export const internalIdHealth = Arr.map(internalOnly, (carrier) => (rng: Random): Sample => {
	const record = { lang: "en", fields: [], diagnosis: rng.pick(diagnoses), rowId: rng.between(1000, 99_999) } as const;
	const payload = carriers[carrier].render({ record, rng, minified: rng.chance(0.2) });

	return { scene: carriers[carrier], payload };
});
