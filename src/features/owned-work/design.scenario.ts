import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Session, scenario } from "#tools/driver/index.ts";
import { entryKind } from "./recorded.ts";

const model = "ultra-a/claude-fable-5-2";

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

const startedIn = (parent: Session, name: string) =>
	Arr.findFirst(parent.entries, (entry: SessionEntry) =>
		Option.filter(decodeStarted(entry), ({ data }) => data.name === name),
	);

const childOf = (parent: Session, name: string, delegates: ReadonlyArray<Session>) =>
	Option.flatMap(startedIn(parent, name), ({ data }) =>
		Arr.findFirst(delegates, ({ id }) => id === data.child_session_id),
	);

const wakeOf = (parent: Session, name: string) =>
	Option.flatMap(startedIn(parent, name), ({ data }) =>
		Arr.findFirst(parent.entries, (entry) =>
			Option.filter(decodeWake(entry), ({ details }) => details.ref === data.handle),
		),
	);

const ownerTask = (child: string, role: string, design: string, task: string) =>
	Arr.join(
		[
			"This run tests how a design reaches each owner, so do nothing else: read no files, run no playbook or skill.",
			`Use the delegate tool once to start one ${role} named "${child}" with model ${model}${design}. Its message is exactly the text between the lines BEGIN ${child} and END ${child}.`,
			`BEGIN ${child}`,
			task,
			`END ${child}`,
			"Then end your turn. When its result wakes you, reply with that result alone.",
		],
		"\n",
	);

const runnerTask = "Run the bash command `echo $PI_OWNED_WORK_LEVEL`, then reply with its output alone.";

const levelThreeTask = Arr.join(
	[
		"You are starting the first runner of an arena for your own design. Do not read the arena skill: start the runner this message names and nothing else.",
		ownerTask("arena runner", "leaf", "", runnerTask),
	],
	"\n",
);

const request = (sketch: string) =>
	Arr.join(
		[
			'Name the goal "Prove a last-level owner handed its own design starts leaves" in your delegate call.',
			ownerTask(
				"level two",
				"owner",
				` and design ${sketch}`,
				ownerTask("level three", "owner", " and design yours", levelThreeTask),
			),
		],
		"\n",
	);

const sketchOf = (home: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const sketch = `${home}/design/rationale.md`;

		yield* fs.makeDirectory(`${home}/design`, { recursive: true });
		yield* fs.writeFileString(sketch, "# Design scenario\n\n## Synthesis decision\n\nBase: the only candidate.\n");

		return sketch;
	});

const sentAll = (session: Session, text: string) =>
	Arr.isReadonlyArrayNonEmpty(session.requests) && Arr.every(session.requests, Str.includes(text));

scenario({
	env: process.env,
	model,
	play: (run) =>
		Effect.gen(function* () {
			const sketch = yield* sketchOf(run.home);

			yield* run.root.prompt(request(sketch));

			const { levelTwo, levelThree, wake } = yield* run.waitFor(
				"the level-3 owner's wake from its arena runner",
				"10 minutes",
				({ root, delegates }) =>
					Option.flatMap(childOf(root, "level two", delegates), (two) =>
						Option.flatMap(childOf(two, "level three", delegates), (three) =>
							Option.map(wakeOf(three, "arena runner"), (found) => ({
								levelTwo: two,
								levelThree: three,
								wake: found,
							})),
						),
					),
			);

			const answer = Str.trim(wake.details.outcome.text ?? "");

			yield* run.say(wake.details);
			yield* run.check(
				sentAll(levelTwo, `Your design is settled: build to the sketch ${sketch}.`),
				`every request of the level-2 owner says to build to the sketch ${sketch}`,
			);
			yield* run.check(
				sentAll(levelThree, "Your design is yours to settle: run the `architect` skill before you write code."),
				"every request of the level-3 owner says its design is its own and to run architect first",
			);
			yield* run.check(
				wake.details.outcome.status === "done" && answer === "4",
				`the level-3 owner's wake records its arena runner done at level 4 (it settled ${wake.details.outcome.status} with ${answer})`,
			);
		}),
});
