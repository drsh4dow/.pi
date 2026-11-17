import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { terminalNameOf } from "#src/client/hc/index.ts";
import { treeReader } from "#src/features/cost/index.ts";
import { type Run, type Session, scenario } from "#tools/driver/index.ts";
import { atLevel, type ChildRole } from "./child.ts";
import { entryKind } from "./recorded.ts";

const model = "ultra-a/claude-fable-5-2";

const Started = Schema.Struct({
	type: Schema.Literal("custom"),
	customType: Schema.Literal(entryKind),
	data: Schema.Struct({
		type: Schema.Literal("delegate-started"),
		name: Schema.String,
		child_session_id: Schema.String,
	}),
});

const Wake = Schema.Struct({ type: Schema.Literal("custom_message"), customType: Schema.Literal(entryKind) });

const Usage = Schema.Struct({ cost: Schema.Struct({ total: Schema.Finite }) });

const Priced = Schema.Struct({ type: Schema.Literal("message"), message: Schema.Struct({ usage: Usage }) });

const decodeStarted = Schema.decodeUnknownOption(Started);

const decodeWake = Schema.decodeUnknownOption(Wake);

const decodePriced = Schema.decodeUnknownOption(Priced);

const leafTask = "Run the bash command `sleep 60`, then reply with the single word ok.";

const ownerTask = (child: string, role: ChildRole, task: string) =>
	Arr.join(
		[
			"This run tests how deep delegation goes, so do nothing else: read no files, run no playbook or skill.",
			`Use the delegate tool once to start one ${role} named "${child}" with model ${model}. Its message is exactly the text between the lines BEGIN ${child} and END ${child}.`,
			`BEGIN ${child}`,
			task,
			`END ${child}`,
			"Then end your turn. When its result wakes you, reply with that result alone.",
		],
		"\n",
	);

const levelThreeTask = ownerTask("level four", "leaf", leafTask);

const request = Arr.join(
	[
		'Name the goal "Prove a level-3 owner starts a tracked level-4 leaf" in your delegate call.',
		ownerTask("level two", "owner", ownerTask("level three", "owner", levelThreeTask)),
	],
	"\n",
);

const startedAs = (name: string, root: Session, delegates: ReadonlyArray<Session>) =>
	Arr.findFirst(
		Arr.flatMap([root, ...delegates], ({ entries }) => entries),
		(entry: SessionEntry) => Option.filter(decodeStarted(entry), ({ data }) => data.name === name),
	).pipe(
		Option.flatMap(({ data }) => Arr.findFirst(delegates, ({ id }) => id === data.child_session_id)),
		Option.filter(({ loaded }) => Option.isSome(loaded)),
	);

const parentOf = (path: string) => Str.replace(/\/[^/]*$/u, "")(path);

const lastPart = (path: string) => Str.replace(/^.*\//u, "")(path);

const Listed = Schema.Struct({ address: Schema.String, name: Schema.optionalKey(Schema.String) });

const Terminals = Schema.Struct({ terminals: Schema.Array(Listed) });

const decodeList = Schema.decodeEffect(Schema.fromJsonString(Terminals));

const decodeTerminal = Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })));

const processOf = (run: Run, name: string) =>
	Effect.gen(function* () {
		const listed = yield* Effect.flatMap(run.exec(["hc", "ls"]), ({ output }) => decodeList(output));
		const named = Arr.filter(listed.terminals, (found) => found.name === terminalNameOf(name));
		const terminal = Option.getOrElse(Arr.head(Arr.map(named, (found) => found.address)), () => "none");

		const { pid } = yield* Effect.flatMap(run.exec(["hc", "get", terminal]), ({ output }) => decodeTerminal(output));

		const read = (file: string) =>
			Effect.map(run.exec(["cat", `/proc/${String(pid)}/${file}`]), ({ output }) => Str.trim(output));

		const oom = yield* read("oom_score_adj");
		const cgroup = yield* read("cgroup");

		return { pid, oom, cgroup: Str.replace(/^0::/u, "")(cgroup) };
	});

const scopeOf = (run: Run, name: string, level: number, role: ChildRole) =>
	Effect.gen(function* () {
		const { oomScoreAdj } = atLevel({ level, role });
		const found = yield* processOf(run, name);

		yield* run.say(`${name}: pid ${String(found.pid)} at ${found.oom} in ${found.cgroup}`);
		yield* run.check(
			found.oom === oomScoreAdj,
			`${name} runs at OOM score adjustment ${oomScoreAdj} (it runs at ${found.oom})`,
		);

		return found.cgroup;
	});

const checkNesting = (
	run: Run,
	{
		levelTwo,
		levelThree,
		levelFour,
	}: { readonly levelTwo: string; readonly levelThree: string; readonly levelFour: string },
) =>
	Effect.gen(function* () {
		const rootSlice = lastPart(parentOf(parentOf(levelTwo)));
		const status = yield* run.exec(["systemctl", "--user", "status", "--no-pager", "--full", rootSlice]);

		yield* run.say(status.output);
		yield* run.check(
			Str.startsWith(`${parentOf(levelThree)}/`)(levelFour) &&
				Str.startsWith(`${parentOf(levelTwo)}/`)(levelThree) &&
				Str.includes(lastPart(levelFour))(status.output),
			`systemctl --user status ${rootSlice} shows the leaf's scope ${levelFour} inside the level-3 owner's slice ${parentOf(levelThree)}`,
		);
	});

const leafSpend = (leaf: Session) =>
	Arr.reduce(
		Arr.getSomes(Arr.map(leaf.entries, (entry) => decodePriced(entry))),
		0,
		(sum, { message }) => sum + message.usage.cost.total,
	);

const checkCost = (run: Run, root: Session, leaf: Session) =>
	Effect.gen(function* () {
		const label = yield* treeReader({ root: root.file, delegates: parentOf(leaf.file) }).read;
		const counted = Arr.findFirst(label.delegates, ({ name }) => name === "level four");
		const spent = Math.round(leafSpend(leaf) * 10_000) / 10_000;

		yield* run.say(label);
		yield* run.check(
			spent > 0 && Option.exists(counted, ({ usd }) => usd === spent),
			`the cost label counts the level-4 leaf's $${String(spent)} (it shows ${Option.match(counted, { onNone: () => "no entry", onSome: ({ usd }) => `$${String(usd)}` })})`,
		);
	});

scenario({
	model,
	play: (run) =>
		Effect.gen(function* () {
			yield* run.root.prompt(request);

			const running = yield* run.waitFor("the level-4 leaf running", "5 minutes", ({ root, delegates }) =>
				startedAs("level four", root, delegates),
			);

			const levelTwo = yield* scopeOf(run, "level two", 2, "owner");
			const levelThree = yield* scopeOf(run, "level three", 3, "owner");
			const levelFour = yield* scopeOf(run, "level four", 4, "leaf");

			yield* checkNesting(run, { levelTwo, levelThree, levelFour });

			const settled = yield* run.waitFor("the root's wake from level two", "10 minutes", ({ root, delegates }) =>
				Option.as(
					Arr.findFirst(root.entries, (entry) => decodeWake(entry)),
					{ root, leaf: Arr.findFirst(delegates, ({ id }) => id === running.id) },
				),
			);

			yield* Option.match(settled.leaf, {
				onNone: () => run.check(false, "the leaf's session is still in the run"),
				onSome: (leaf) => checkCost(run, settled.root, leaf),
			});
		}),
});
