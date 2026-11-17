/**
 * A protected parent's delegate runs the model its alias names, and the PHI router picks only the account per request.
 * The root runs on phi/auto in enforce mode and starts a fable, an investigator and a divergent leaf in turn. Each child
 * reads a synthetic record from the wire manifest, then a clean file, so its clean brief, its sealed turn and its clean
 * turn after the seal each land on a local mock that records the provider and the model id. The openai mock also
 * answers the Decisions judge, and a proxy that refuses every connection keeps any other request off the network.
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
import type { Carrier, Personal } from "./gate.ts";
import { serveOpenAi } from "./openai.fixture.ts";
import { stubs } from "./policy/policy.ts";
import { providersOf } from "./session.fixture.ts";

/** What the design promises for one alias: where its clean turns land and the id they name, and the id on ent. */
interface Child {
	readonly alias: "fable" | "investigator" | "divergent";
	readonly clean: { readonly on: ReadonlyArray<Personal>; readonly id: string };
	readonly sealedId: string;
}

const children: ReadonlyArray<Child> = [
	{ alias: "fable", clean: { on: ["ultra-a", "ultra-b"], id: "claude-fable-5-2" }, sealedId: "claude-fable-5-2" },
	{ alias: "investigator", clean: { on: ["openai"], id: "gpt-6.1-sol" }, sealedId: "claude-opus-5-5" },
	{ alias: "divergent", clean: { on: ["opencode-go"], id: "glm-5.3-flash" }, sealedId: "claude-opus-5-5" },
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

const personalBodies = () => [
	...claude["ultra-a"].bodies(),
	...claude["ultra-b"].bodies(),
	...openai.bodies(),
	...opencodeGo.bodies(),
];

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

const pairsOf = (turns: ReadonlyArray<Served>) =>
	Arr.join(
		Arr.map(turns, ({ carrier, model }) => `${carrier}/${model}`),
		", ",
	);

const landed = (run: Run, child: Child, planted: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const mark = marksOf(child.alias);
		const [task, record, after] = [turnsOf(mark.task), turnsOf(mark.record), turnsOf(mark.after)];
		const onClean = ({ carrier, model }: Served) => Arr.contains(child.clean.on, carrier) && model === child.clean.id;
		const onEnt = ({ carrier, model }: Served) => carrier === "ent" && model === child.sealedId;
		const leaked = foundIn({ bodies: Arr.map(after, ({ body }) => body), tokens: planted });
		const cleanWhere = `${Arr.join(child.clean.on, " or ")} as ${child.clean.id}`;

		yield* run.check(
			Arr.isArrayNonEmpty(task) && Arr.every(task, onClean),
			`the ${child.alias} child's clean brief went to ${cleanWhere} (it went to ${pairsOf(task)})`,
		);
		yield* run.check(
			Arr.isArrayNonEmpty(record) && Arr.every(record, onEnt),
			`the ${child.alias} child's sealed turn went to ent as ${child.sealedId} (it went to ${pairsOf(record)})`,
		);
		yield* run.check(
			Arr.isArrayNonEmpty(after) && Arr.every(after, onClean),
			`the ${child.alias} child's clean turn after the seal went to ${cleanWhere} (it went to ${pairsOf(after)})`,
		);
		yield* run.check(
			Arr.every(after, ({ body }) => Str.includes(stubs.sealed)(body)) && leaked.length === 0,
			`the ${child.alias} child's clean turn after the seal carries the record withheld and no canary (leaked: ${Arr.join(leaked, ", ")})`,
		);
	});

const EnabledModels = Schema.Struct({ enabledModels: Schema.Array(Schema.String) });

const decodeEnabled = Schema.decodeUnknownOption(EnabledModels);

/** The child is the delegate whose payloads carry its brief's mark. */
const startedOn = (run: Run, child: Child, sessions: ReadonlyArray<Session>) =>
	Effect.gen(function* () {
		const key = `phi/${child.clean.id}`;
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
			Option.contains(model, key),
			`the ${child.alias} child's pi runs on ${key} (it runs on ${Option.getOrElse(model, () => "nothing recorded")})`,
		);
		yield* run.check(
			Option.exists(enabled, (models) => !Arr.contains(models, key)),
			`the ${child.alias} child's enabledModels leave out ${key} (they are ${Option.match(enabled, { onNone: () => "unset", onSome: Arr.join(", ") })})`,
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
