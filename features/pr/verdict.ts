import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { Gh } from "../../clients/gh/index.ts";

export const VerdictResult = Schema.Literals(["pass", "pass+notes", "fail", "incomplete"]);

export type VerdictResult = typeof VerdictResult.Type;

export const VerdictRecord = Schema.Struct({
	repo: Schema.String,
	number: Schema.Finite,
	head: Schema.String,
	patchId: Schema.String,
	result: VerdictResult,
	verifier: Schema.Struct({ name: Schema.String, session: Schema.String, model: Schema.String }),
	answer: Schema.String,
});

export type VerdictRecord = typeof VerdictRecord.Type;

export type ReviewTarget = Pick<VerdictRecord, "repo" | "number" | "head" | "patchId">;

export const verdictsFolder = (home: string) => `${home}/.local/state/pi-agent/verdicts`;

const encode = Schema.encodeEffect(Schema.fromJsonString(VerdictRecord));

export const recordVerdict = (root: string) => (record: VerdictRecord) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const folder = `${root}/${record.repo}/${String(record.number)}`;
		const json = yield* encode(record);

		yield* fs.makeDirectory(folder, { recursive: true });
		yield* fs.writeFileString(`${folder}/${record.head}.${record.verifier.session}.json`, json);
	});

export const pin = (pr: string) =>
	Effect.flatMap(Gh, (gh) =>
		Effect.all({ view: gh.view(pr), patchId: gh.patchId(pr) }, { concurrency: 2 }).pipe(
			Effect.map(({ view: { repo, number, head }, patchId }): ReviewTarget => ({ repo, number, head, patchId })),
		),
	);
