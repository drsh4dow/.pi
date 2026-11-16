/**
 * The border holds when `route()` dispatches wrongly. A pi loads the real router through `border.fixture.ts`, which
 * sends every request to `ultra-a`, with the real verdict store and the real border in claude-accounts. No sealed or
 * never-judged content may reach a personal mock, in any form.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario } from "../../tools/driver/index.ts";
import { lastMessageText, mockedModels, Reply, serveMock } from "./anthropic.fixture.ts";
import { ContextSeen, fixtureEntryType, forcedAccount, planted } from "./border.fixture.ts";
import { foundIn } from "./canary-tokens.ts";
import { LaneJson } from "./lanes.ts";
import { sha256 } from "./policy/digest.ts";
import { stubs } from "./policy/policy.ts";
import { VerdictsEntry, verdictsEntryType } from "./store.ts";

const prompts = {
	cleared: `Note the build tag ${planted.cleared}. Reply with the single word done.`,
	sealed: `Synthetic intake for a border test: ${planted.sealed}, ssn ${planted.ssn}. Reply with the single word done.`,
	neverJudged: `Keep this slot in mind: ${planted.slot}. Reply with the single word done.`,
	closing: "Reply with the single word done.",
} as const;

const order = ["cleared", "sealed", "neverJudged", "closing"] as const;

/** The clean prompts are registered fixtures, so only the system prompt reaches the live judge. */
const settings = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
	mode: "enforce",
	fixtures: Arr.map([prompts.cleared, prompts.neverJudged, prompts.closing], sha256),
});

const reply = () => Reply.Text({ text: "done" });

const mocks = { "ultra-a": serveMock(reply), "ultra-b": serveMock(reply), ent: serveMock(reply) };

const keepBodies = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		yield* fs.makeDirectory(`${run.home}/border-mocks`);
		yield* Effect.forEach(Rec.toEntries(mocks), ([account, mock]) =>
			fs.writeFileString(`${run.home}/border-mocks/${account}.jsonl`, Arr.join(mock.bodies(), "\n")),
		);
	});

const forcedBodies = () => mocks[forcedAccount].bodies();

const personalBodies = () => [...mocks["ultra-a"].bodies(), ...mocks["ultra-b"].bodies()];

const base64Run = /[A-Za-z0-9+/]{16,}={0,2}/gu;

const textDecoder = new TextDecoder();

const decodedRuns = (body: string) =>
	Arr.flatMap(Arr.fromIterable(Str.matchAll(base64Run)(body)), ([run]) =>
		Result.match(Encoding.Base64.decode(run), {
			onSuccess: (bytes) => [textDecoder.decode(bytes)],
			onFailure: () => [],
		}),
	);

const leakedIn = (bodies: ReadonlyArray<string>, markers: ReadonlyArray<string>) =>
	foundIn({ bodies: [...bodies, ...Arr.flatMap(bodies, decodedRuns)], tokens: markers });

const sealedMarkers = [planted.ssn, Str.replaceAll("-", "")(planted.ssn), planted.sealed];

const holding = (bodies: ReadonlyArray<string>, markers: ReadonlyArray<string>) =>
	Arr.filter(bodies, (body) => Arr.isReadonlyArrayNonEmpty(leakedIn([body], markers))).length;

const counted = (bodies: ReadonlyArray<string>) => ({
	bodies: bodies.length,
	sealed: holding(bodies, sealedMarkers),
	neverJudged: holding(bodies, [planted.neverJudged]),
	cleared: holding(bodies, [planted.cleared]),
	sealedStub: Arr.filter(bodies, Str.includes(stubs.sealed)).length,
	unknownStub: Arr.filter(bodies, Str.includes(stubs.unknown)).length,
});

const SeenEntry = Schema.Struct({
	type: Schema.Literal("custom"),
	customType: Schema.Literal(fixtureEntryType),
	data: ContextSeen,
});

const VerdictsLine = Schema.Struct({
	type: Schema.Literal("custom"),
	customType: Schema.Literal(verdictsEntryType),
	data: VerdictsEntry,
});

const AssistantLine = Schema.Struct({
	type: Schema.Literal("message"),
	message: Schema.Struct({ role: Schema.Literal("assistant"), provider: Schema.String }),
});

const linesAs = <Value>(schema: Schema.Codec<Value, string>, text: string) =>
	Arr.getSomes(Arr.map(Str.split(text, "\n"), (line) => Schema.decodeOption(schema)(line)));

const jsonlUnder = Effect.fn("jsonlUnder")(function* (folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const files = yield* fs.readDirectory(folder, { recursive: true });

	const texts = yield* Effect.forEach(Arr.filter(files, Str.endsWith(".jsonl")), (file) =>
		fs.readFileString(`${folder}/${file}`),
	);

	return Arr.join(texts, "\n");
});

const sent = (run: Run) =>
	Effect.gen(function* () {
		const pwd = yield* run.exec(["pwd"]);
		const sessions = `${Str.trim(pwd.output)}/border-sessions`;

		const pi = yield* run.exec([
			"pi",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"-e",
			`${run.agentDir}/extensions/claude-accounts/index.ts`,
			"-e",
			`${import.meta.dir}/border.fixture.ts`,
			"--model",
			"phi/auto",
			"--session-dir",
			sessions,
			"-p",
			...Arr.map(order, (name) => prompts[name]),
		]);

		yield* run.say(`pi exited ${String(pi.code)}: ${Str.trim(pi.output)}`);
		yield* run.check(pi.code === 0, `the fixture pi answered every prompt (it exited ${String(pi.code)})`);

		const session = yield* jsonlUnder(sessions);
		const lanes = yield* jsonlUnder(`${run.home}/.local/state/pi-phi-router/lanes`);

		return { session, lanes: linesAs(LaneJson, lanes) };
	});

type Sent = Effect.Success<ReturnType<typeof sent>>;

const onTheWay = (run: Run, { session }: Sent) =>
	Effect.gen(function* () {
		const seen = Arr.map(linesAs(Schema.fromJsonString(SeenEntry), session), ({ data }) => data);
		const entries = linesAs(Schema.fromJsonString(VerdictsLine), session);
		const verdicts = Arr.flatMap(entries, ({ data }) => data.verdicts);

		yield* run.say({ seen });
		yield* run.check(
			Str.includes(planted.ssn)(session) && Str.includes(planted.slot)(session),
			"the session file holds the SSN prompt and the slot prompt as typed",
		);
		yield* run.check(
			Arr.some(seen, ({ ssn }) => ssn > 0) && Arr.some(seen, ({ neverJudged }) => neverJudged > 0),
			`the context before the border carried the SSN and the never-judged marker (${String(seen.length)} requests seen)`,
		);
		yield* run.check(
			Arr.some(verdicts, ([, seal, why]) => seal === "s" && why === "ssn"),
			"a phi-verdicts entry sealed a part on the ssn rule",
		);
	});

const misrouted = (run: Run, { session, lanes }: Sent) =>
	Effect.gen(function* () {
		const providers = Arr.map(
			linesAs(Schema.fromJsonString(AssistantLine), session),
			({ message }) => message.provider,
		);

		const wouldBe = Arr.flatMap(lanes, (line) => (line.type === "route" ? [line.wouldBe] : []));
		const borders = Arr.filter(lanes, (line) => line.type === "border");

		yield* run.say({ providers, wouldBe, borders });
		yield* run.check(Arr.contains(wouldBe, "ent"), `the router chose ent for a request (${Arr.join(wouldBe, ", ")})`);
		yield* run.check(
			providers.length === order.length && Arr.every(providers, (provider) => provider === forcedAccount),
			`every answer came from ${forcedAccount} (${Arr.join(providers, ", ")})`,
		);
		yield* run.check(
			forcedBodies().length === order.length && mocks.ent.bodies().length === 0,
			`one ${forcedAccount} body per prompt and none on ent (${String(forcedBodies().length)} and ${String(mocks.ent.bodies().length)})`,
		);
		yield* run.check(
			Arr.isReadonlyArrayNonEmpty(borders) &&
				Arr.every(borders, ({ account, refused }) => account === forcedAccount && !refused),
			`the border logged the ${forcedAccount} requests and refused none`,
		);
	});

const lastSentFor = (name: (typeof order)[number]) => {
	const body = Arr.get(forcedBodies(), order.indexOf(name));

	return body.pipe(Effect.fromOption, Effect.flatMap(lastMessageText), Effect.option);
};

const heldBorder = (run: Run) =>
	Effect.gen(function* () {
		const leakedSealed = leakedIn(personalBodies(), sealedMarkers);
		const leakedNever = leakedIn(personalBodies(), [planted.neverJudged]);

		yield* run.check(
			leakedSealed.length === 0,
			`no personal body carries the sealed content (found ${Arr.join(leakedSealed, ", ")})`,
		);
		yield* run.check(leakedNever.length === 0, "no personal body carries the never-judged marker");
		yield* run.check(
			Arr.some(forcedBodies(), Str.includes(planted.cleared)),
			`a ${forcedAccount} body carries the cleared marker`,
		);
		const sealedSent = yield* lastSentFor("sealed");
		const neverSent = yield* lastSentFor("neverJudged");

		yield* run.check(
			Option.contains(sealedSent, stubs.sealed),
			`the body that carried the SSN prompt has the sealed stub in its place (${Option.getOrElse(sealedSent, () => "none")})`,
		);
		yield* run.check(
			Option.contains(neverSent, stubs.unknown),
			`the body that carried the edited slot prompt has the never-judged stub in its place (${Option.getOrElse(neverSent, () => "none")})`,
		);
	});

scenario({
	model: "phi/auto",
	models: mockedModels(mocks),
	play: (run) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const encoded = yield* settings;

			yield* fs.writeFileString(`${run.home}/.pi/agent/phi-router.json`, `${encoded}\n`);

			const result = yield* sent(run);

			yield* keepBodies(run);

			yield* run.say({
				"ultra-a": counted(mocks["ultra-a"].bodies()),
				"ultra-b": counted(mocks["ultra-b"].bodies()),
				ent: counted(mocks.ent.bodies()),
			});
			yield* onTheWay(run, result);
			yield* heldBorder(run);
			yield* misrouted(run, result);
		}),
});
