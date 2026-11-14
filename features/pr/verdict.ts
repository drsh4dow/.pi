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

/** What a verifier reviews, pinned when its parent starts it, never taken from its answer. */
export type ReviewTarget = Pick<VerdictRecord, "repo" | "number" | "head" | "patchId">;

/** Every verdict on the machine sits under this folder, so a `gh` wrapper started anywhere finds a pull request's verdicts. */
export const verdictsFolder = (home: string) => `${home}/.local/state/pi-agent/verdicts`;

const encode = Schema.encodeEffect(Schema.fromJsonString(VerdictRecord));

/** One file per verifier per head, so two verifiers never write the same file. */
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
