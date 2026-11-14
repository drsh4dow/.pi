/**
 * A root that writes a 17 KB `STATE.md` through a bash heredoc gets an error on that call, naming the state cap and
 * the decision trail, and the write stays on disk. A later read of the oversized file comes back as it was.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario } from "../../tools/driver/index.ts";

const folder = "~/.local/state/pi-agent/scratch/cap";

const BashCall = Schema.Struct({
	type: Schema.Literal("toolCall"),
	id: Schema.String,
	name: Schema.Literal("bash"),
	arguments: Schema.Struct({ command: Schema.String }),
});

const Part = Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) });

const BashResult = Schema.Struct({
	type: Schema.Literal("message"),
	message: Schema.Struct({
		role: Schema.Literal("toolResult"),
		toolCallId: Schema.String,
		toolName: Schema.Literal("bash"),
		isError: Schema.Boolean,
		content: Schema.Array(Part),
	}),
});

const decodeCall = Schema.decodeUnknownOption(BashCall);
const decodeResult = Schema.decodeUnknownOption(BashResult);

interface Ran {
	readonly command: string;
	readonly isError: boolean;
	readonly text: string;
}

const callsIn = (entry: SessionEntry) =>
	entry.type === "message" && entry.message.role === "assistant"
		? Arr.getSomes(Arr.map(entry.message.content, (part) => decodeCall(part)))
		: [];

/** Every bash call the root ran, with its result, oldest first. */
const bashRuns = (entries: ReadonlyArray<SessionEntry>): ReadonlyArray<Ran> => {
	const calls = Arr.flatMap(entries, callsIn);
	const results = Arr.getSomes(Arr.map(entries, (entry) => decodeResult(entry)));

	return Arr.getSomes(
		Arr.map(results, ({ message }) => {
			const call = Arr.findFirst(calls, ({ id }) => id === message.toolCallId);

			const text = Arr.join(
				Arr.map(message.content, (part) => part.text ?? ""),
				"\n",
			);

			return Option.map(call, ({ arguments: { command } }) => ({ command, isError: message.isError, text }));
		}),
	);
};

const ranCommand = (run: Run, what: string, marker: string) =>
	run.waitFor(what, "30 seconds", ({ root }) =>
		Arr.findFirst(bashRuns(root.entries), ({ command }) => Str.includes(marker)(command)),
	);

const describe = ({ command, isError, text }: Ran) => `${command}\nisError ${String(isError)}\n${text}`;

/** Has the root write STATE.md past the cap, checks the call errs, and returns the file's size on disk. */
const writeOversized = Effect.fn("writeOversized")(function* (run: Run) {
	const fs = yield* FileSystem.FileSystem;

	yield* run.root.prompt(
		Arr.join(
			[
				"This is a harness test. Run exactly this bash command once, as written:",
				"",
				`mkdir -p ${folder} && cat > ${folder}/STATE.md <<EOF`,
				"# State",
				String.raw`$(head -c 17000 /dev/zero | tr '\0' x)`,
				"EOF",
				"",
				"Then run nothing else and change no file. Reply with the text the call returned.",
			],
			"\n",
		),
	);

	const write = yield* ranCommand(run, "the heredoc's result", "<<EOF");
	const info = yield* fs.stat(`${run.home}/.local/state/pi-agent/scratch/cap/STATE.md`);
	const bytes = Number(info.size);

	yield* run.say(describe(write));
	yield* run.check(bytes > 16_384, `the heredoc wrote STATE.md past the cap (it is ${String(bytes)} bytes)`);
	yield* run.check(
		write.isError && Str.includes("16,384")(write.text) && Str.includes("decisions.tsv")(write.text),
		`the heredoc's result is an error naming 16,384 and decisions.tsv (isError ${String(write.isError)})`,
	);

	return bytes;
});

scenario({
	model: "ultra-a/claude-fable-5-2",
	play: (run) =>
		Effect.gen(function* () {
			const bytes = yield* writeOversized(run);

			yield* run.root.prompt(
				`Run exactly this bash command once: wc -c ${folder}/STATE.md\nThen reply with its output.`,
			);

			const read = yield* ranCommand(run, "the read's result", "wc -c");

			yield* run.say(describe(read));
			yield* run.check(
				!read.isError && Str.includes(String(bytes))(read.text),
				`reading the oversized STATE.md comes back as it was, with its ${String(bytes)} bytes (isError ${String(read.isError)})`,
			);
		}),
});
