import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario, type Spawned } from "../../tools/driver/index.ts";
import { type Asked, compactionPrompt, mockedModels, Reply, serveMock } from "./anthropic.fixture.ts";
import { seenOn, tokensOf } from "./canary-tokens.ts";
import { cleanReachOf, failed, type Outcome, strataOf, tableOf } from "./corpus-wire-table.ts";
import { fillerMark, type Plan, planOf, Step } from "./corpus-wire.ts";
import { decodeJsonLines } from "./corpus/jsonl.ts";
import { type Case, CaseFromJsonLine, Synthetic } from "./corpus/manifest.ts";

class Usage extends Schema.TaggedError<Usage, { readonly brand: unique symbol }>()("Usage", {
	message: Schema.String,
}) {}

const usage =
	"usage: bun features/phi-router/corpus-wire.scenario.ts <manifest.jsonl> [--concurrency N] [--only id,id]\nsynthetic.json must sit beside the manifest, as generate.ts writes it.";

interface Args {
	readonly manifest: string;
	readonly concurrency: number;
	readonly only: Option.Option<ReadonlyArray<string>>;
}

const flagOf = (argv: ReadonlyArray<string>, name: string) =>
	Option.flatMap(
		Arr.findFirstIndex(argv, (arg) => arg === name),
		(at) => Arr.get(argv, at + 1),
	);

const argsOf = (argv: ReadonlyArray<string>) => {
	const manifest = Option.filter(Arr.head(argv), (first) => !Str.startsWith("-")(first));
	const concurrency = Option.getOrElse(Option.map(flagOf(argv, "--concurrency"), Number), () => 8);
	const only = Option.map(flagOf(argv, "--only"), Str.split(","));

	if (Option.isNone(manifest) || !Number.isInteger(concurrency) || concurrency < 1) {
		return Effect.fail(Usage.make({ message: usage }));
	}

	return Effect.succeed<Args>({ manifest: manifest.value, concurrency, only });
};

const replierOf = (plan: Plan) => {
	const replies = MutableRef.make(plan.replies);
	const summaries = MutableRef.make(Arr.filter(plan.steps, Step.$is("Compact")));

	return ({ lastText, body }: Asked) => {
		if (Str.includes(compactionPrompt)(body)) {
			const [next, ...rest] = MutableRef.get(summaries);

			MutableRef.set(summaries, rest);

			return Reply.Text({ text: next?.summary ?? "done" });
		}

		if (Str.includes(fillerMark)(lastText)) {
			return Reply.Text({ text: "ok" });
		}

		const [next = Reply.Text({ text: "done" }), ...rest] = MutableRef.get(replies);

		MutableRef.set(replies, rest);

		return next;
	};
};

const mocksOf = (plan: Plan) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const reply = replierOf(plan);

			return { "ultra-a": serveMock(reply), "ultra-b": serveMock(reply), ent: serveMock(reply) };
		}),
		(mocks) => Effect.forEach(Rec.values(mocks), ({ stop }) => stop),
	);

type Mocks = Effect.Success<ReturnType<typeof mocksOf>>;

const requests = (mocks: Mocks) =>
	mocks["ultra-a"].bodies().length + mocks["ultra-b"].bodies().length + mocks.ent.bodies().length;

const plant = Effect.fn("plant")(function* (pi: Spawned, plan: Plan) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.makeDirectory(`${pi.project}/files`);
	yield* Effect.forEach(plan.files, ({ path, bytes }) => fs.writeFile(`${pi.project}/${path}`, bytes));
	yield* Effect.forEach(Option.toArray(plan.agents), (agents) =>
		fs.writeFileString(`${pi.project}/AGENTS.md`, agents),
	);
});

/** Sends the steering message once the prompt's first request reached a mock, while the tool call it asked for runs. */
const steered = (pi: Spawned, mocks: Mocks, turn: Extract<Step, { readonly _tag: "Turn" }>) =>
	Effect.gen(function* () {
		const before = requests(mocks);
		const prompted = yield* Effect.forkChild(pi.prompt(turn.prompt, "3 minutes"));

		yield* Effect.forEach(Option.toArray(turn.steer), (steer) =>
			Effect.sync(() => requests(mocks)).pipe(
				Effect.repeat({ until: (count) => count > before, schedule: Schedule.spaced("100 millis") }),
				Effect.andThen(pi.steer(steer)),
			),
		);

		yield* Fiber.join(prompted);
	});

const played = (pi: Spawned, mocks: Mocks, plan: Plan) =>
	Effect.forEach(plan.steps, (step) =>
		Step.$match(step, {
			Turn: (turn) => steered(pi, mocks, turn),
			Compact: () => pi.compact,
		}),
	);

const outcomeOf = Effect.fn("outcomeOf")(function* (subject: Case, mocks: Mocks, broken: Option.Option<string>) {
	const tracked = yield* tokensOf(subject);
	const personal = [...mocks["ultra-a"].bodies(), ...mocks["ultra-b"].bodies()];
	const ent = mocks.ent.bodies();

	return {
		id: subject.id,
		expect: subject.expect,
		strata: strataOf(subject),
		personal: personal.length,
		ent: Arr.filter(ent, (body) => !Str.includes(compactionPrompt)(body)).length,
		...seenOn({ tracked, personal, ent }),
		broken,
	} satisfies Outcome;
});

const playCase = (run: Run, subject: Case) =>
	Effect.scoped(
		Effect.gen(function* () {
			const plan = planOf(subject);
			const mocks = yield* mocksOf(plan);

			const broken = yield* Effect.gen(function* () {
				const pi = yield* run.spawn({ name: subject.id, providers: mockedModels(mocks) });

				yield* plant(pi, plan);
				yield* played(pi, mocks, plan);
			}).pipe(
				Effect.timeout("6 minutes"),
				Effect.as(Option.none<string>()),
				Effect.catch((error) => Effect.succeedSome(error.message)),
			);

			return yield* outcomeOf(subject, mocks, broken);
		}),
	);

const casesOf = Effect.fn("casesOf")(function* (args: Args) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(args.manifest);
	const cases = yield* decodeJsonLines({ schema: CaseFromJsonLine, source: args.manifest, text });

	return Option.match(args.only, {
		onNone: () => cases,
		onSome: (ids) => Arr.filter(cases, ({ id }) => Arr.contains(ids, id)),
	});
});

const Settings = Schema.Struct({ mode: Schema.Literal("enforce"), synthetic: Synthetic });

const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(Settings));

const decodeSynthetic = Schema.decodeEffect(Schema.fromJsonString(Synthetic));

/** The router settings for the run: enforce, and the corpus's test identities from `synthetic.json` beside the manifest. */
const syntheticOf = Effect.fn("syntheticOf")(function* (manifest: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* fs.readFileString(path.join(path.dirname(manifest), "synthetic.json"));
	const synthetic = yield* decodeSynthetic(text);

	return yield* encodeSettings({ mode: "enforce", synthetic });
});

/** A token as the report shows it: an encoded run is hundreds of characters, and its start names it. */
const shown = Str.slice(0, 48);

/** The table, each clean case's lane, the fragments that reached a personal mock, and each failed case. */
const report = Effect.fn("report")(function* (run: Run, outcomes: ReadonlyArray<Outcome>) {
	const fragments = Arr.filter(outcomes, ({ fragments: found }) => found.length > 0);

	yield* run.say(tableOf(outcomes));
	yield* run.say(Arr.join(cleanReachOf(outcomes).lines, "\n"));
	yield* Effect.forEach(fragments, ({ id, fragments: found }) => run.say({ id, fragments: Arr.map(found, shown) }));
	yield* Effect.forEach(Arr.filter(outcomes, failed), ({ id, leaked, unsealed: pieces, missing, broken }) =>
		run.say({
			id,
			leaked: Arr.map(leaked, shown),
			unsealed: Arr.map(pieces, shown),
			missing: Arr.map(missing, shown),
			broken: Option.getOrElse(broken, () => ""),
		}),
	);
});

const verdict = Effect.fn("verdict")(function* (run: Run, outcomes: ReadonlyArray<Outcome>, seconds: number) {
	const failures = Arr.filter(outcomes, failed);
	const leaks = Arr.filter(outcomes, ({ leaked }) => leaked.length > 0);
	const unsealed = Arr.filter(outcomes, ({ unsealed: pieces }) => pieces.length > 0);

	yield* report(run, outcomes);
	yield* run.say(`${String(outcomes.length)} cases in ${String(seconds)} s, ${String(failures.length)} failed`);
	yield* run.check(
		leaks.length === 0,
		`no complete identifier reached a personal mock (${String(leaks.length)} cases leaked)`,
	);
	yield* run.check(
		unsealed.length === 0,
		`no message holding an identifier reached a personal mock (${String(unsealed.length)} cases)`,
	);
	yield* run.check(failures.length === 0, `every case delivered its PHI to ent (${String(failures.length)} failed)`);
	yield* run.check(
		cleanReachOf(outcomes).reached > 0,
		"some clean case reached a personal mock, so zero leaks is not vacuous",
	);
});

scenario({
	model: "phi/auto",
	settings: { compaction: { enabled: true, keepRecentTokens: 1000 } },
	play: (run) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const args = yield* argsOf(Arr.drop(process.argv, 2));
			const cases = yield* casesOf(args);
			const started = yield* Clock.currentTimeMillis;

			const synthetic = yield* syntheticOf(args.manifest);

			yield* fs.writeFileString(`${run.home}/.pi/agent/phi-router.json`, `${synthetic}\n`);

			const outcomes = yield* Effect.forEach(cases, (subject) => playCase(run, subject), {
				concurrency: args.concurrency,
			});

			const ended = yield* Clock.currentTimeMillis;

			yield* verdict(run, outcomes, Math.round((ended - started) / 1000));
		}),
});
