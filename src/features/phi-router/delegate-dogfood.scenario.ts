/**
 * The delegate-wire fact on real providers and the real judge. The root runs on phi/auto in enforce mode and starts a
 * fable and an investigator leaf on a synthetic chart that holds a name, an MRN and a DOB. Each child runs the model
 * its alias names and every turn lands on an account that serves that model. The fable child is routed, so the
 * identifiers send a turn to ent. The investigator child runs wholly on openai, a BAA provider, with nothing judged. It
 * costs real model calls, and prints each child's physical models and the routed child's lane log.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { entryKind } from "#src/features/owned-work/index.ts";
import { type Run, type Session, scenario } from "#tools/driver/index.ts";
import { LaneJson } from "./lanes.ts";

interface Child {
	readonly alias: "fable" | "investigator";
	readonly key: string;
	/** Every `provider/model` pi may record for one of the child's turns. */
	readonly servedBy: ReadonlyArray<string>;
}

const children: ReadonlyArray<Child> = [
	{
		alias: "fable",
		key: "phi/claude-fable-5-2",
		servedBy: ["ultra-a/claude-fable-5-2", "ultra-b/claude-fable-5-2", "ent/claude-fable-5-2"],
	},
	{ alias: "investigator", key: "openai/gpt-6.1-sol", servedBy: ["openai/gpt-6.1-sol"] },
];

/** The PHI router routes only a child on a `phi` model, so only such a child has a lane log and a turn on ent. */
const isRouted = (child: Child) => Str.startsWith("phi/")(child.key);

/**
 * Invented, but plausible: the judge clears identifiers that look fake, such as `MRN 000-SYNTH-0001`. The children read
 * it from a file, since the parent's bridge prompt tells it to withhold identifiers from a brief it writes.
 */
const chart = "Maria Delgado-Ruiz, MRN 48213977, DOB 1958-03-14, seen for a persistent cough.\n";

const requestFor = (chartPath: string) =>
	Arr.join(
		[
			`In one turn, use the delegate tool twice with goal "Prove a protected parent's delegates run their alias models", both as leaves: one named "fable child" with model fable, one named "investigator child" with model investigator.`,
			`Give each this exact task message: Read the file ${chartPath} and summarize it in one sentence. Then reply ok.`,
			"Then end your turn without waiting for them.",
		],
		"\n",
	);

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

const decodeStarted = Schema.decodeUnknownOption(Started);

/** The child's last message is its final answer. A wake may name the child's group rather than the child. */
const answered = (session: Session) =>
	Option.exists(
		Arr.findLast(session.entries, (entry) => entry.type === "message"),
		(entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop",
	);

const settled = (run: Run, name: string) =>
	run.waitFor(`the answer of the ${name}`, "10 minutes", ({ root, delegates }) => {
		const started = Arr.findFirst(root.entries, (entry) =>
			Option.filter(decodeStarted(entry), ({ data }) => data.name === name),
		);

		return Option.flatMap(started, ({ data }) =>
			Arr.findFirst(delegates, (session) => session.id === data.child_session_id && answered(session)),
		);
	});

const modelChangesOf = (session: Session) =>
	Arr.flatMap(session.entries, (entry) =>
		entry.type === "model_change" ? [`${entry.provider}/${entry.modelId}`] : [],
	);

const servedOf = (session: Session) =>
	Arr.flatMap(session.entries, (entry) =>
		entry.type === "message" && entry.message.role === "assistant"
			? [`${entry.message.provider}/${entry.message.model}`]
			: [],
	);

const lanesOf = (run: Run, session: Session) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(`${run.home}/.local/state/pi-phi-router/lanes/${session.id}.jsonl`);

		const lines = yield* Effect.forEach(Arr.filter(Str.split(text, "\n"), Str.isNonEmpty), (line) =>
			Schema.decodeEffect(LaneJson)(line),
		);

		return Arr.map(lines, (line) =>
			line.type === "route"
				? { type: line.type, dispatched: line.dispatched, model: line.model, why: line.why }
				: { type: line.type, account: line.account, stubbedSealed: line.stubbedSealed, refused: line.refused },
		);
	});

/** Waits for the child's answer and prints what it ran on, so a failed check of one child still shows both. */
const observed = (run: Run, child: Child) =>
	Effect.gen(function* () {
		const session = yield* settled(run, `${child.alias} child`);
		const modelChanges = modelChangesOf(session);
		const served = servedOf(session);
		const lanes = isRouted(child) ? yield* lanesOf(run, session) : [];

		yield* run.say({ child: child.alias, modelChanges, served, lanes });

		return { child, modelChanges, served };
	});

const checked = (run: Run, { child, modelChanges, served }: Effect.Success<ReturnType<typeof observed>>) =>
	Effect.gen(function* () {
		yield* run.check(
			Arr.isReadonlyArrayNonEmpty(modelChanges) && Arr.every(modelChanges, (key) => key === child.key),
			`the ${child.alias} child's session runs on ${child.key} (its model_change entries: ${Arr.join(modelChanges, ", ")})`,
		);
		yield* run.check(
			Arr.isReadonlyArrayNonEmpty(served) && Arr.every(served, (pair) => Arr.contains(child.servedBy, pair)),
			`every turn of the ${child.alias} child ran on ${Arr.join(child.servedBy, " or ")} (they ran on ${Arr.join(served, ", ")})`,
		);

		if (isRouted(child)) {
			yield* run.check(
				Arr.some(served, Str.startsWith("ent/")),
				`a turn of the ${child.alias} child went to ent (none did: the router cleared a chart holding a name, an MRN and a DOB, a finding)`,
			);
		}
	});

scenario({
	env: process.env,
	model: "phi/auto",
	play: (run) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* fs.writeFileString(`${run.home}/.pi/agent/phi-router.json`, '{"mode":"enforce"}\n');
			yield* fs.writeFileString(`${run.home}/chart.txt`, chart);
			yield* run.root.prompt(requestFor(`${run.home}/chart.txt`));

			const seen = yield* Effect.forEach(children, (child) => observed(run, child));

			yield* Effect.forEach(seen, (child) => checked(run, child));
		}),
});
