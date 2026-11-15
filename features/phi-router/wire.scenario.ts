import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario } from "../../tools/driver/index.ts";
import { entryKind } from "../owned-work/index.ts";
import { type Asked, compactionPrompt, mockedModels, Reply, serveMock } from "./anthropic.fixture.ts";
import { foundIn } from "./canary-tokens.ts";
import { providersOf } from "./session.fixture.ts";

const Case = Schema.Struct({
	id: Schema.String,
	strata: Schema.Struct({ entry: Schema.Literals(["file-read", "tool-result"]) }),
	canaries: Schema.NonEmptyArray(Schema.String),
	messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
});

type Case = typeof Case.Type;

const decodeManifest = Schema.decodeUnknownEffect(Schema.Array(Schema.fromJsonString(Case)));

const toolUse = (name: string, input: Schema.JsonObject) => Reply.ToolUse({ before: Option.none(), name, input });

const readRecord = ({ id, strata }: Case) =>
	strata.entry === "file-read"
		? toolUse("read", { path: `records/${id}.txt` })
		: toolUse("bash", { command: `cat records/${id}.txt` });

const recordSteps = (cases: ReadonlyArray<Case>) =>
	Arr.zip(
		["STEP-PHI", ...Arr.map(cases, ({ canaries }) => Arr.headNonEmpty(canaries))],
		[...Arr.map(cases, readRecord), Reply.Text({ text: "done" })],
	);

const planted = MutableRef.make<ReadonlyArray<Case>>([]);

const steps: ReadonlyArray<readonly [string, Reply]> = [
	["STEP-CLEAN", toolUse("read", { path: "notes.txt" })],
	[
		"STEP-DELEGATE",
		toolUse("delegate", {
			name: "wire child",
			role: "leaf",
			model: "judgment",
			goal: "Answer a wire test",
			message: "CHILD-TASK. Reply with the single word ok and call no tool.",
		}),
	],
	["STEP-CODEMODE", toolUse("codemode", { code: 'const m = await models.classify("x", {}); return m;' })],
];

const reply = ({ lastText, body }: Asked) => {
	if (Str.includes(compactionPrompt)(body)) {
		return Reply.Text({ text: "The agent read the notes and the records." });
	}

	const cases = MutableRef.get(planted);
	const step = Arr.findFirst([...steps, ...recordSteps(cases)], ([word]) => Str.includes(word)(lastText));

	return Option.getOrElse(
		Option.map(step, ([, next]) => next),
		() => Reply.Text({ text: "done" }),
	);
};

type Counts = Readonly<Record<"ultra-a" | "ultra-b" | "ent", number>>;

const atFirstEnt = MutableRef.make(Option.none<Counts>());

const mocks = {
	"ultra-a": serveMock(reply),
	"ultra-b": serveMock(reply),
	ent: serveMock((asked) => {
		MutableRef.update(atFirstEnt, Option.orElseSome(counts));

		return reply(asked);
	}),
};

const personalBodies = () => [...mocks["ultra-a"].bodies(), ...mocks["ultra-b"].bodies()];

const counts = (): Counts => ({
	"ultra-a": mocks["ultra-a"].bodies().length,
	"ultra-b": mocks["ultra-b"].bodies().length,
	ent: mocks.ent.bodies().length,
});

const casesOf = (text: string) => decodeManifest(Arr.filter(Str.split(text, "\n"), Str.isNonEmpty));

const recordText = (messages: Case["messages"]) =>
	`${Arr.join(
		Arr.map(messages, ({ text }) => text),
		"\n",
	)}\n`;

const notes = `${Arr.join(Arr.replicate("The build uses bun and the tests live next to the code.", 250), "\n")}\n`;

const plant = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pwd = yield* run.exec(["pwd"]);
		const project = Str.trim(pwd.output);
		const manifest = yield* fs.readFileString(`${import.meta.dir}/wire.manifest.jsonl`);

		const cases = yield* Effect.tap(casesOf(manifest), (decoded) =>
			Effect.sync(() => MutableRef.set(planted, decoded)),
		);

		yield* fs.writeFileString(`${run.home}/.pi/agent/phi-router.json`, '{"mode":"enforce"}\n');
		yield* fs.writeFileString(`${project}/notes.txt`, notes);
		yield* fs.makeDirectory(`${project}/records`);
		yield* Effect.forEach(cases, ({ id, messages }) =>
			fs.writeFileString(`${project}/records/${id}.txt`, recordText(messages)),
		);

		return Arr.flatMap(cases, ({ canaries }) => canaries);
	});

const wakeAnswered = (run: Run) =>
	run.waitFor("the root's answer to the child's wake", "5 minutes", ({ root }) => {
		const wake = Arr.findLastIndex(
			root.entries,
			(entry) => entry.type === "custom_message" && entry.customType === entryKind,
		);

		return Option.flatMap(wake, (index) =>
			Option.liftPredicate(providersOf(Arr.drop(root.entries, index + 1)), Arr.isArrayNonEmpty),
		);
	});

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const BlockedCodemode = Schema.Struct({
	type: Schema.Literal("message"),
	message: Schema.Struct({
		role: Schema.Literal("toolResult"),
		toolName: Schema.Literal("codemode"),
		isError: Schema.Literal(true),
		content: Schema.Array(TextBlock),
	}),
});

const isBlockedCodemode = (entry: SessionEntry) =>
	Option.exists(Schema.decodeUnknownOption(BlockedCodemode)(entry), ({ message }) =>
		Arr.some(message.content, ({ text }) => Str.includes("outside the PHI router")(text)),
	);

const latchedSteps = (run: Run) =>
	Effect.gen(function* () {
		yield* run.root.prompt("STEP-AFTER. A clean question after the records were read.");
		yield* run.root.prompt("STEP-DELEGATE. Start the delegate.");
		yield* wakeAnswered(run);
		yield* run.root.prompt("STEP-CODEMODE. Run the script.");
		yield* run.root.compact;
		yield* run.root.prompt("STEP-FINAL. One more clean question.");
	});

const finalState = (run: Run) =>
	run.waitFor("every session", "10 seconds", ({ root, delegates }) =>
		Option.some({
			rootProviders: providersOf(root.entries),
			childProviders: Arr.flatMap(delegates, ({ entries }) => providersOf(entries)),
			blocked: Arr.some(root.entries, isBlockedCodemode),
		}),
	);

interface Seen {
	readonly canaries: ReadonlyArray<string>;
	readonly atLatch: Counts;
	readonly atEnd: Counts;
	readonly childProviders: ReadonlyArray<string>;
	readonly blocked: boolean;
}

const personalCount = (counted: Counts) => counted["ultra-a"] + counted["ultra-b"];

const noLeak = (run: Run, { canaries, atLatch }: Seen) =>
	Effect.gen(function* () {
		const leaked = foundIn({ bodies: personalBodies(), tokens: canaries });
		const missing = Arr.difference(canaries, foundIn({ bodies: mocks.ent.bodies(), tokens: canaries }));

		yield* run.check(
			canaries.length === 12,
			`the manifest plants 12 canaries (it planted ${String(canaries.length)})`,
		);
		yield* run.check(leaked.length === 0, `no canary reaches a personal mock (leaked: ${Arr.join(leaked, ", ")})`);
		yield* run.check(missing.length === 0, `every canary reached the ent mock (missing: ${Arr.join(missing, ", ")})`);
		yield* run.check(
			personalCount(atLatch) >= 2,
			`the clean turns reached a personal mock (${String(personalCount(atLatch))} requests)`,
		);
	});

const allOnEnt = (run: Run, { atLatch, atEnd, childProviders, blocked }: Seen) =>
	Effect.gen(function* () {
		const entBodies = mocks.ent.bodies();
		const childOnEnt = childProviders.length > 0 && Arr.every(childProviders, (provider) => provider === "ent");

		yield* run.check(
			atEnd["ultra-a"] === atLatch["ultra-a"] && atEnd["ultra-b"] === atLatch["ultra-b"],
			`no request after the latch reached a personal mock (${String(personalCount(atLatch))} at the latch, ${String(personalCount(atEnd))} at the end)`,
		);
		yield* run.check(
			childOnEnt && Arr.some(entBodies, Str.includes("CHILD-TASK")),
			`the child started after the latch ran on ent (its answers came from ${Arr.join(childProviders, ", ")})`,
		);
		yield* run.check(
			Arr.some(entBodies, Str.includes(compactionPrompt)),
			"the compaction after the latch went to the ent mock",
		);
		yield* run.check(blocked, "the codemode script that calls models was blocked by the PHI router's guard");
	});

const verdict = (run: Run, { canaries, atLatch }: Pick<Seen, "canaries" | "atLatch">) =>
	Effect.gen(function* () {
		const { rootProviders, childProviders, blocked } = yield* finalState(run);
		const seen = { canaries, atLatch, atEnd: counts(), childProviders, blocked };

		yield* run.say({ atLatch, atEnd: seen.atEnd, rootProviders, childProviders });
		yield* noLeak(run, seen);
		yield* allOnEnt(run, seen);
	});

scenario({
	model: "phi/auto",
	settings: { compaction: { enabled: true, keepRecentTokens: 1000 } },
	models: mockedModels(mocks),
	play: (run) =>
		Effect.gen(function* () {
			const canaries = yield* plant(run);

			yield* run.root.prompt("STEP-CLEAN. Read the notes.");
			yield* run.root.prompt("STEP-PHI. Read the records one at a time.");

			const atLatch = Option.getOrElse(MutableRef.get(atFirstEnt), counts);

			yield* latchedSteps(run);
			yield* verdict(run, { canaries, atLatch });
		}),
});
