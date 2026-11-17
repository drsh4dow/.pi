/**
 * A protected parent's delegate runs the model its alias names, and the PHI router picks only the account per request.
 * The root runs on phi/auto in enforce mode and starts a fable, an investigator and a divergent leaf in turn. Each child
 * reads a synthetic record from the wire manifest, then a clean file, so its clean brief, its sealed turn and its clean
 * turn after the seal each land on a local mock that records the provider and the model id. The investigator runs on
 * openai, a BAA provider, unrouted. The openai mock also answers the Decisions judge, and a proxy that refuses every
 * connection keeps any other request off the network.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { entryKind } from "#src/features/owned-work/index.ts";
import { type Run, type Session, scenario } from "#tools/driver/index.ts";
import { type Asked, mockedModels, Reply, serveMock } from "./anthropic.fixture.ts";
import { foundIn } from "./corpus/canary-tokens.ts";
import { type Carrier, isPersonal } from "./gate.ts";
import { serveOpenAi } from "./openai.fixture.ts";
import { stubs } from "./policy/policy.ts";
import { providersOf } from "./session.fixture.ts";

const substitute = "ent/claude-opus-5-5";

/** What the design promises for one alias: the model its pi starts on, and the `provider/id` its turns land on. */
interface Child {
	readonly alias: "fable" | "investigator" | "divergent";
	readonly key: string;
	readonly clean: ReadonlyArray<string>;
	readonly sealed: string;
}

const children: ReadonlyArray<Child> = [
	{
		alias: "fable",
		key: "phi/claude-fable-5-2",
		clean: ["ultra-a/claude-fable-5-2", "ultra-b/claude-fable-5-2"],
		sealed: "ent/claude-fable-5-2",
	},
	{ alias: "investigator", key: "openai/gpt-6.1-sol", clean: ["openai/gpt-6.1-sol"], sealed: "openai/gpt-6.1-sol" },
	{ alias: "divergent", key: "phi/glm-5.3-flash", clean: ["opencode-go/glm-5.3-flash"], sealed: substitute },
];

/** The words that tell the mocks which turn they answer: the root's prompt, the child's brief and its two tool results. */
const marksOf = (alias: Child["alias"]) => ({
	step: `STEP-${alias}`,
	task: `TASK-${alias}`,
	record: `RECORD-${alias}`,
	after: `AFTER-${alias}`,
});

const toolUse = (name: string, input: Schema.JsonObject) => Reply.ToolUse({ before: Option.none(), name, input });

const stepsOf = ({ alias }: Child): ReadonlyArray<readonly [string, Reply]> => {
	const mark = marksOf(alias);

	return [
		[
			mark.step,
			toolUse("delegate", {
				name: `${alias} child`,
				role: "leaf",
				model: alias,
				goal: "Answer a wire test",
				message: `${mark.task}. Read ${alias}.record.txt, then ${alias}.after.txt, then reply done.`,
			}),
		],
		[mark.task, toolUse("read", { path: `${alias}.record.txt` })],
		[mark.record, toolUse("read", { path: `${alias}.after.txt` })],
		[mark.after, Reply.Text({ text: "done" })],
	];
};

const steps = Arr.flatMap(children, stepsOf);

interface Served {
	readonly carrier: Carrier;
	readonly model: string;
	readonly mark: Option.Option<string>;
	readonly body: string;
}

const served: Array<Served> = [];

const replying = (carrier: Carrier) => (asked: Asked) => {
	const step = Arr.findFirst(steps, ([mark]) => Str.includes(mark)(asked.lastText));

	served.push({ carrier, model: asked.model, mark: Option.map(step, ([mark]) => mark), body: asked.body });

	return Option.getOrElse(
		Option.map(step, ([, next]) => next),
		() => Reply.Text({ text: "done" }),
	);
};

const canaries = MutableRef.make<ReadonlyArray<string>>([]);

const holdsCanary = (piece: string) => Arr.some(MutableRef.get(canaries), (canary) => Str.includes(canary)(piece));

const claude = {
	"ultra-a": serveMock(replying("ultra-a")),
	"ultra-b": serveMock(replying("ultra-b")),
	ent: serveMock(replying("ent")),
};

const openai = serveOpenAi({ reply: replying("openai"), sealed: holdsCanary });

const opencodeGo = serveOpenAi({ reply: replying("opencode-go"), sealed: holdsCanary });

const personalBodies = () => [...claude["ultra-a"].bodies(), ...claude["ultra-b"].bodies(), ...opencodeGo.bodies()];

const refused = "http://127.0.0.1:9";

/** The undici dispatcher pi installs honours these, so a request to any host but the mocks fails instead of reaching it. */
const offline = {
	HTTP_PROXY: refused,
	HTTPS_PROXY: refused,
	http_proxy: refused,
	https_proxy: refused,
	NO_PROXY: "127.0.0.1",
	no_proxy: "127.0.0.1",
};

const Case = Schema.Struct({
	canaries: Schema.NonEmptyArray(Schema.String),
	messages: Schema.Array(Schema.Struct({ text: Schema.String })),
});

const decodeCase = Schema.decodeUnknownEffect(Schema.fromJsonString(Case));

/** The manifest's first case. */
const firstCase = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const manifest = yield* fs.readFileString(`${import.meta.dir}/wire.manifest.jsonl`);
	const line = yield* Effect.fromOption(Arr.head(Str.split(manifest, "\n")));

	return yield* decodeCase(line);
});

const plant = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pwd = yield* run.exec(["pwd"]);
		const project = Str.trim(pwd.output);
		const record = yield* firstCase;
		const texts = Arr.map(record.messages, ({ text }) => text);
		const recordText = Arr.join(texts, "\n");

		MutableRef.set(canaries, record.canaries);

		yield* fs.writeFileString(`${run.home}/.pi/agent/phi-router.json`, '{"mode":"enforce"}\n');
		yield* Effect.forEach(children, ({ alias }) => {
			const mark = marksOf(alias);

			return Effect.andThen(
				fs.writeFileString(`${project}/${alias}.record.txt`, `${mark.record}\n${recordText}\n`),
				fs.writeFileString(`${project}/${alias}.after.txt`, `${mark.after}. The build uses bun.\n`),
			);
		});

		return record.canaries;
	});

const isWake = (entry: SessionEntry) => entry.type === "custom_message" && entry.customType === entryKind;

const wakeAnswered = (run: Run, count: number) =>
	run.waitFor(`the root's answer to wake ${String(count)}`, "5 minutes", ({ root }) => {
		const wakes = Arr.flatMap(root.entries, (entry, index) => (isWake(entry) ? [index] : []));

		return Option.flatMap(Arr.get(wakes, count - 1), (index) =>
			Option.liftPredicate(providersOf(Arr.drop(root.entries, index + 1)), Arr.isArrayNonEmpty),
		);
	});

const turnsOf = (mark: string) => Arr.filter(served, (turn) => Option.contains(turn.mark, mark));

const pairOf = ({ carrier, model }: Served) => `${carrier}/${model}`;

const pairsOf = (turns: ReadonlyArray<Served>) => Arr.join(Arr.map(turns, pairOf), ", ");

/** A personal provider receives the record withheld, a BAA provider receives it raw. */
const recordAsDue = (planted: ReadonlyArray<string>) => (turn: Served) => {
	const raw = foundIn({ bodies: [turn.body], tokens: planted }).length > 0;

	return isPersonal(turn.carrier) ? !raw && Str.includes(stubs.sealed)(turn.body) : raw;
};

/** Whether a Decisions request carries the child's own content: its record or the clean file it read after. */
const judgedOf = (child: Child) => {
	const { record, after } = marksOf(child.alias);

	return Arr.some(openai.decisions(), (body) => Str.includes(record)(body) || Str.includes(after)(body));
};

const landed = (run: Run, child: Child, planted: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const mark = marksOf(child.alias);
		const [task, record, after] = [turnsOf(mark.task), turnsOf(mark.record), turnsOf(mark.after)];
		const onClean = (turn: Served) => Arr.contains(child.clean, pairOf(turn));
		const onSealed = (turn: Served) => pairOf(turn) === child.sealed;

		yield* run.check(
			Arr.isArrayNonEmpty(task) && Arr.every(task, onClean),
			`the ${child.alias} child's clean brief went to ${Arr.join(child.clean, " or ")} (it went to ${pairsOf(task)})`,
		);
		yield* run.check(
			Arr.isArrayNonEmpty(record) && Arr.every(record, onSealed),
			`the ${child.alias} child's sealed turn went to ${child.sealed} (it went to ${pairsOf(record)})`,
		);
		yield* run.check(
			Arr.isArrayNonEmpty(after) && Arr.every(after, onClean),
			`the ${child.alias} child's clean turn after the seal went to ${Arr.join(child.clean, " or ")} (it went to ${pairsOf(after)})`,
		);
		yield* run.check(
			Arr.every([...record, ...after], recordAsDue(planted)),
			`each of the ${child.alias} child's turns from the record on carries it raw to a BAA provider and withheld from a personal one`,
		);
		yield* run.check(
			judgedOf(child) === Str.startsWith("phi/")(child.key),
			`the Decisions judge reads the ${child.alias} child's content exactly when the router routes it (${child.key})`,
		);
	});

const EnabledModels = Schema.Struct({ enabledModels: Schema.Array(Schema.String) });

const decodeEnabled = Schema.decodeUnknownOption(EnabledModels);

const isRegisteredPhi = (key: string) => Str.startsWith("phi/")(key) && key !== "phi/auto";

/** The child is the delegate whose payloads carry its brief's mark. */
const startedOn = (run: Run, child: Child, sessions: ReadonlyArray<Session>) =>
	Effect.gen(function* () {
		const { task } = marksOf(child.alias);
		const session = Arr.findFirst(sessions, ({ requests }) => Arr.some(requests, Str.includes(task)));
		const loaded = Option.flatMap(session, (found) => found.loaded);
		const model = Option.map(loaded, (found) => found.model);

		const enabled = Option.flatMap(loaded, (found) =>
			Option.map(decodeEnabled(found.settings), ({ enabledModels }) => enabledModels),
		);

		yield* run.say({
			child: child.alias,
			startedOn: Option.getOrNull(model),
			enabledModels: Option.getOrNull(enabled),
		});
		yield* run.check(
			Option.contains(model, child.key),
			`the ${child.alias} child's pi runs on ${child.key} (it runs on ${Option.getOrElse(model, () => "nothing recorded")})`,
		);
		yield* run.check(
			Option.exists(enabled, (models) => !Arr.some(models, isRegisteredPhi)),
			`the ${child.alias} child's enabledModels hold no phi model but phi/auto (they are ${Option.match(enabled, { onNone: () => "unset", onSome: Arr.join(", ") })})`,
		);
	});

const judgeWire = (run: Run, planted: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const leaked = foundIn({ bodies: personalBodies(), tokens: planted });
		const judgedRaw = foundIn({ bodies: openai.decisions(), tokens: planted });

		yield* run.check(leaked.length === 0, `no canary reaches a personal mock (leaked: ${Arr.join(leaked, ", ")})`);
		yield* run.check(
			judgedRaw.length > 0,
			`the Decisions judge on the openai mock read the record raw (${String(openai.decisions().length)} calls)`,
		);
	});

scenario({
	env: { ...process.env, ...offline },
	model: "phi/auto",
	models: mockedModels({ ...claude, openai, "opencode-go": opencodeGo }),
	play: (run) =>
		Effect.gen(function* () {
			const planted = yield* plant(run);

			yield* Effect.forEach(children, ({ alias }, index) =>
				Effect.andThen(
					run.root.prompt(`${marksOf(alias).step}. Start the ${alias} child.`),
					wakeAnswered(run, index + 1),
				),
			);

			const sessions = yield* run.waitFor("every child's session", "10 seconds", ({ delegates }) =>
				Option.liftPredicate(delegates, (all) => all.length === children.length),
			);

			yield* run.say({
				served: Arr.map(served, ({ carrier, model, mark }) => [carrier, model, Option.getOrElse(mark, () => "")]),
			});
			yield* Effect.forEach(children, (child) =>
				Effect.andThen(landed(run, child, planted), startedOn(run, child, sessions)),
			);
			yield* judgeWire(run, planted);
		}),
});
