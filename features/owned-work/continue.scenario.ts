import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario } from "../../tools/driver/index.ts";
import { entryKind } from "./recorded.ts";

const leafName = "flaky leaf";

const Outcome = Schema.Struct({ status: Schema.String, reason: Schema.optionalKey(Schema.String) });

const Wake = Schema.Struct({
	type: Schema.Literal("custom_message"),
	customType: Schema.Literal(entryKind),
	details: Schema.Struct({
		ref: Schema.String,
		name: Schema.Literal(leafName),
		session: Schema.String,
		outcome: Outcome,
		next: Schema.optionalKey(Schema.String),
	}),
});

const decodeWake = Schema.decodeUnknownOption(Wake);

const wakes = (entries: ReadonlyArray<SessionEntry>) => Arr.getSomes(Arr.map(entries, (entry) => decodeWake(entry)));

const nthWake = (run: Run, nth: number) =>
	run.waitFor(`wake ${String(nth)} of "${leafName}"`, "5 minutes", ({ root }) =>
		Option.map(Arr.get(wakes(root.entries), nth - 1), ({ details }) => details),
	);

const down = (run: Run) => `${run.home}/provider-down`;

/**
 * The provider is down while a flag file exists in the run's HOME, since pi resolves a `!command` key at each request.
 */
const key = String.raw`!test -e "$HOME/provider-down" && echo down || jq -r .openai.key "$HOME/.pi/agent/auth.json"`;

const start = `Use the delegate tool once to start a leaf named "${leafName}" with model flaky/gpt-6-luna and goal "Get the word ok from a leaf". Its whole task: reply with the single word ok. Then end your turn without waiting for it. When its result wakes you, whatever it is, reply with the single word noted and call no tool.`;

const resume = `The provider works again. Do what the \`next\` of the wake for "${leafName}" says, with no message, and end your turn without waiting.`;

const failedWake = (run: Run) =>
	Effect.gen(function* () {
		const failed = yield* nthWake(run, 1);
		const next = failed.next ?? "none";

		yield* run.say(failed);
		yield* run.check(
			failed.outcome.reason === "errored" && Str.includes(`continues "${failed.ref}"`)(next),
			`the first wake failed on a provider error and its next names continues "${failed.ref}" (reason ${failed.outcome.reason ?? "none"}, next ${next})`,
		);

		return failed;
	});

const continuedWake = (run: Run, failed: typeof Wake.Type.details) =>
	Effect.gen(function* () {
		const done = yield* nthWake(run, 2);

		yield* run.say(done);
		yield* run.check(
			done.outcome.status === "done" && done.session === failed.session && done.ref !== failed.ref,
			`the second wake is done under the same name and session ${failed.session} (it is ${done.outcome.status} on ${done.session})`,
		);
	});

const bothRunsInOneFile = (run: Run, session: string) =>
	Effect.gen(function* () {
		const files = yield* run.waitFor("the leaf's session", "10 seconds", ({ delegates }) =>
			Option.some(Arr.filter(delegates, ({ id }) => id === session)),
		);

		const text = yield* FileSystem.FileSystem.pipe(
			Effect.flatMap((fs) => fs.readFileString(Option.getOrElse(Arr.head(files), () => ({ file: "none" })).file)),
		);

		const lines = Str.split(text, "\n");
		const headers = Arr.filter(lines, Str.startsWith('{"type":"session"')).length;
		const prompts = Arr.filter(lines, Str.includes('"role":"user"')).length;
		const errored = Arr.some(lines, Str.includes('"stopReason":"error"'));

		yield* run.check(
			files.length === 1 && headers === 1 && prompts === 2 && errored,
			`one session file holds both runs under one header (${String(files.length)} files, ${String(headers)} headers, ${String(prompts)} prompts, errored run ${String(errored)})`,
		);
	});

scenario({
	model: "ultra-a/claude-fable-5-2",
	models: {
		flaky: {
			baseUrl: "https://api.openai.com/v1",
			api: "openai-responses",
			apiKey: key,
			models: [{ id: "gpt-6-luna" }],
		},
	},
	play: (run) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* fs.writeFileString(down(run), "");
			yield* run.root.prompt(start);

			const failed = yield* failedWake(run);

			yield* fs.remove(down(run));
			yield* run.root.prompt(resume);
			yield* continuedWake(run, failed);
			yield* bothRunsInOneFile(run, failed.session);
		}),
});
