import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { Gh, GhError } from "#src/client/gh/index.ts";

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

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(VerdictRecord));

const folderOf = (root: string, { repo, number }: Pick<VerdictRecord, "repo" | "number">) =>
	`${root}/${repo}/${String(number)}`;

/** Every record of one pull request, by file name. A file that does not read as a record is left out. */
export const verdictsOf = (root: string) => (pr: Pick<VerdictRecord, "repo" | "number">) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const folder = folderOf(root, pr);
		const names = yield* Effect.orElseSucceed(fs.readDirectory(folder), Arr.empty<string>);
		const files = Arr.sort(Arr.filter(names, Str.endsWith(".json")), Order.String);

		const read = yield* Effect.forEach(files, (file) =>
			Effect.option(Effect.flatMap(fs.readFileString(`${folder}/${file}`), decode)),
		);

		return Arr.getSomes(read);
	});

export const recordVerdict = (root: string) => (record: VerdictRecord) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const folder = folderOf(root, record);
		const json = yield* encode(record);

		yield* fs.makeDirectory(folder, { recursive: true });
		yield* fs.writeFileString(`${folder}/${record.head}.${record.verifier.session}.json`, json);
	});

/** Reads the head again after the diff, so a push in between cannot pin one head with another's patch-id. */
export const pin = (pr: string) =>
	Effect.gen(function* () {
		const gh = yield* Gh;
		const { repo, number, head } = yield* gh.view(pr);
		const patchId = yield* gh.patchId(pr);
		const after = yield* gh.view(pr);

		if (after.head !== head) {
			const why = `its head moved from ${head} to ${after.head} while it was pinned, so start the verifier again`;

			return yield* GhError.make({ args: ["gh", "pr", "view", pr], why });
		}

		const target: ReviewTarget = { repo, number, head, patchId };

		return target;
	});
