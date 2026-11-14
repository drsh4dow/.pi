import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario } from "../../tools/driver/index.ts";
import { entryKind } from "./recorded.ts";

const goal = "Prove that each delegate gets its brief by role";

const fact = "Brief scenario project fact: the build command is make all.";

const ownerRule = "Brief scenario owner rule: push only to work branches.";

const noRules = "no owner rules";

const Started = Schema.Struct({
	type: Schema.Literal("custom"),
	customType: Schema.Literal(entryKind),
	data: Schema.Struct({
		type: Schema.Literal("delegate-started"),
		handle: Schema.String,
		name: Schema.String,
		child_session_id: Schema.String,
	}),
});

const Outcome = Schema.Struct({ status: Schema.String, text: Schema.optionalKey(Schema.String) });

const Wake = Schema.Struct({
	type: Schema.Literal("custom_message"),
	customType: Schema.Literal(entryKind),
	details: Schema.Struct({ ref: Schema.String, outcome: Outcome }),
});

const decodeStarted = Schema.decodeUnknownOption(Started);

const decodeWake = Schema.decodeUnknownOption(Wake);

const startedNamed = (entries: ReadonlyArray<SessionEntry>, name: string) =>
	Arr.findFirst(entries, (entry) => Option.filter(decodeStarted(entry), ({ data }) => data.name === name));

const wakeOf = (entries: ReadonlyArray<SessionEntry>, ref: string) =>
	Arr.findFirst(entries, (entry) => Option.filter(decodeWake(entry), ({ details }) => details.ref === ref));

const settled = (run: Run, name: string) =>
	run.waitFor(`the wake of ${name}`, "5 minutes", ({ root, delegates }) =>
		Option.flatMap(startedNamed(root.entries, name), ({ data }) =>
			Option.all({
				wake: wakeOf(root.entries, data.handle),
				session: Arr.findFirst(delegates, (session) => session.id === data.child_session_id),
			}),
		),
	);

const sentAll = (requests: ReadonlyArray<string>, text: string) =>
	Arr.isReadonlyArrayNonEmpty(requests) && Arr.every(requests, Str.includes(text));

const sentAny = (requests: ReadonlyArray<string>, text: string) => Arr.some(requests, Str.includes(text));

const stateFolder = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const state = `${run.home}/.local/state/pi-agent/brief-scenario/work`;

		yield* fs.makeDirectory(state, { recursive: true });
		yield* fs.writeFileString(`${state}/facts.md`, `${fact}\n`);
		yield* fs.writeFileString(`${state}/owner.md`, `${ownerRule}\nSecond owner rule line.\n`);
	});

const task = `Quote two lines from your system prompt, each on its own line and nothing else: the line that starts with "The user's goal", then the first line inside <owner-rules>, or the words "${noRules}" when your prompt has no <owner-rules> block.`;

const request = Arr.join(
	[
		`Write the file ~/.local/state/pi-agent/brief-scenario/work/STATE.md with the single line "# Brief scenario" using the write tool.`,
		`Then, in one turn, use the delegate tool twice with goal "${goal}", model ultra-a/claude-fable-5-2, and no state or instructionsFile: an owner named "brief owner" and a leaf named "brief leaf". Give each this exact task message: ${task}`,
		"Then end your turn without waiting for them.",
	],
	"\n",
);

const checkOwner = (run: Run, owner: Effect.Success<ReturnType<typeof settled>>) => {
	const text = owner.wake.details.outcome.text ?? "";
	const { requests } = owner.session;

	return Effect.gen(function* () {
		yield* run.say(`owner answered: ${text}`);
		yield* run.check(
			sentAll(requests, `The user's goal: ${goal}`) && sentAll(requests, fact) && sentAll(requests, ownerRule),
			`every request of the owner carries the goal, the project facts and the owner rules (${String(requests.length)} requests)`,
		);
		yield* run.check(
			Str.includes(goal)(text) && Str.includes(ownerRule)(text),
			`the owner quotes its goal and its first owner rule (it answered ${text})`,
		);
	});
};

const checkLeaf = (run: Run, leaf: Effect.Success<ReturnType<typeof settled>>) => {
	const text = leaf.wake.details.outcome.text ?? "";
	const { requests } = leaf.session;

	return Effect.gen(function* () {
		yield* run.say(`leaf answered: ${text}`);
		yield* run.check(
			sentAll(requests, `The user's goal: ${goal}`) && sentAll(requests, fact) && !sentAny(requests, ownerRule),
			`every request of the leaf carries the goal and the project facts, and none the owner rules (${String(requests.length)} requests)`,
		);
		yield* run.check(
			Str.includes(goal)(text) && Str.includes(noRules)(text) && !Str.includes(ownerRule)(text),
			`the leaf quotes its goal and reports no owner rules (it answered ${text})`,
		);
	});
};

scenario({
	model: "ultra-a/claude-fable-5-2",
	play: (run) =>
		Effect.gen(function* () {
			yield* stateFolder(run);
			yield* run.root.prompt(request);
			yield* Effect.flatMap(settled(run, "brief owner"), (owner) => checkOwner(run, owner));
			yield* Effect.flatMap(settled(run, "brief leaf"), (leaf) => checkLeaf(run, leaf));
		}),
});
