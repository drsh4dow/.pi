/**
 * The agent's `bin/` folder comes first on PATH in every shell an agent uses: pi's bash and codemode's bash in a root
 * and in a delegate, and a command the root runs in a `watch`. So `pr-wait` runs, and `gh` is the harness's own.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario } from "../../tools/driver/index.ts";
import { entryKind } from "../owned-work/index.ts";

const probe = "command -v pr-wait gh";

const Text = Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) });

const ToolMessage = Schema.Struct({
	role: Schema.Literal("toolResult"),
	toolName: Schema.String,
	content: Schema.Array(Text),
});

const ToolResult = Schema.Struct({ type: Schema.Literal("message"), message: ToolMessage });

const Outcome = Schema.Struct({ status: Schema.String, tail: Schema.optionalKey(Schema.String) });

const Wake = Schema.Struct({
	type: Schema.Literal("custom_message"),
	customType: Schema.Literal(entryKind),
	details: Schema.Struct({ kind: Schema.String, outcome: Outcome }),
});

const decodeToolResult = Schema.decodeUnknownOption(ToolResult);

const decodeWake = Schema.decodeUnknownOption(Wake);

const textOf = ({ content }: typeof ToolMessage.Type) =>
	Arr.join(
		Arr.map(content, (part) => part.text ?? ""),
		"\n",
	);

/** The text of every result of `tool` in a session that mentions `pr-wait`. */
const outputsOf = (entries: ReadonlyArray<SessionEntry>, tool: string) => {
	const results = Arr.filter(
		Arr.getSomes(Arr.map(entries, (entry) => decodeToolResult(entry))),
		({ message }) => message.toolName === tool,
	);

	return Arr.filter(
		Arr.map(results, ({ message }) => textOf(message)),
		Str.includes("pr-wait"),
	);
};

const wakeOf = (entries: ReadonlyArray<SessionEntry>, kind: string) =>
	Arr.findFirst(entries, (entry) => Option.filter(decodeWake(entry), ({ details }) => details.kind === kind));

const resolvesToBin = (run: Run, shell: string, outputs: ReadonlyArray<string>) => {
	const bin = `${run.home}/.pi/agent/bin`;
	const found = Arr.some(outputs, (text) => Str.includes(`${bin}/pr-wait`)(text) && Str.includes(`${bin}/gh`)(text));
	const printed = Arr.isReadonlyArrayNonEmpty(outputs) ? Arr.join(outputs, " | ") : "nothing";

	return run.check(found, `${shell}: pr-wait and gh resolve to ${bin} (it printed ${printed})`);
};

scenario({
	model: "ultra-a/claude-fable-5-2",
	play: (run) =>
		Effect.gen(function* () {
			const steps = Arr.join(
				[
					"Do these four steps in order, then end your turn without waiting for anything.",
					`1. Run \`${probe}\` with the bash tool.`,
					`2. Run a codemode script that returns the output of tools.bash for \`${probe}\`.`,
					`3. Start a watch with the watch tool on the command \`${probe}\`.`,
					`4. Start one leaf with the delegate tool. Its whole task: run \`${probe}\` with the bash tool, then run a codemode script that returns the output of tools.bash for \`${probe}\`, and reply with both outputs.`,
				],
				"\n",
			);

			yield* run.root.prompt(steps);

			const { root, watch, leaf } = yield* run.waitFor("the watch's and the leaf's wakes", "5 minutes", (found) =>
				Option.all({
					root: Option.some(found.root),
					watch: wakeOf(found.root.entries, "watch"),
					done: wakeOf(found.root.entries, "delegate"),
					leaf: Arr.head(found.delegates),
				}),
			);

			yield* resolvesToBin(run, "the root's bash", outputsOf(root.entries, "bash"));
			yield* resolvesToBin(run, "the root's codemode bash", outputsOf(root.entries, "codemode"));
			yield* resolvesToBin(
				run,
				"the root's watch",
				Option.toArray(Option.fromUndefinedOr(watch.details.outcome.tail)),
			);
			yield* resolvesToBin(run, "the leaf's bash", outputsOf(leaf.entries, "bash"));
			yield* resolvesToBin(run, "the leaf's codemode bash", outputsOf(leaf.entries, "codemode"));
		}),
});
