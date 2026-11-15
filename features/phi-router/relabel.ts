/**
 * `bun features/phi-router/relabel.ts [--sample N] [--seed S]`: the share of request characters bound for a personal
 * account, and a stricter Decisions relabel of a seeded sample of them. Prints counts and ids only, never content.
 */
import type { ClassifierResult } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	ModelRegistry,
	ModelRuntime,
	parseSessionEntries,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Classify, decisionsModel } from "./decisions.ts";
import { type Lane, LaneLine, lanesFolder } from "./lanes.ts";
import { JudgeFailed, type Transcript } from "./policy/index.ts";
import { transcriptOf } from "./session.ts";

export interface Lanes {
	readonly records: ReadonlyArray<Lane>;
	readonly undecodable: ReadonlyArray<{ readonly file: string; readonly line: number }>;
}

const decodeLane = Schema.decodeUnknownOption(LaneLine);

export const parseLanes = (files: ReadonlyArray<{ readonly name: string; readonly text: string }>): Lanes => {
	const lines = Arr.flatMap(files, ({ name, text }) =>
		Arr.map(Str.split(text, "\n"), (line, index) => ({ at: { file: name, line: index + 1 }, line })),
	);

	const decoded = Arr.map(
		Arr.filter(lines, ({ line }) => Str.isNonEmpty(Str.trim(line))),
		({ at, line }) => ({ at, lane: decodeLane(line) }),
	);

	return {
		records: Arr.getSomes(Arr.map(decoded, ({ lane }) => lane)),
		undecodable: Arr.flatMap(decoded, ({ at, lane }) => (Option.isNone(lane) ? [at] : [])),
	};
};

const wouldGoPersonal = (lane: Lane) =>
	lane.reason !== "direct" && (lane.wouldBe === "ultra-a" || lane.wouldBe === "ultra-b");

const charsOf = (lanes: ReadonlyArray<Lane>) => Arr.reduce(lanes, 0, (sum, lane) => sum + lane.chars);

export const personalShare = (records: ReadonlyArray<Lane>) => ({
	personal: charsOf(Arr.filter(records, wouldGoPersonal)),
	routed: charsOf(Arr.filter(records, (lane) => lane.reason !== "direct")),
});

interface Sampling {
	readonly size: number;
	readonly seed: number;
}

/** A uniform sample without replacement: the first `size` of a seeded shuffle. */
export const sampleOf = (input: Sampling & { readonly records: ReadonlyArray<Lane> }) =>
	Random.shuffle(Arr.filter(input.records, wouldGoPersonal)).pipe(
		Effect.map(Arr.take(input.size)),
		Random.withSeed(input.seed),
	);

/** The conversation the branch ending at `leaf` sends, without the system prompt, which no session file holds. */
export const conversationAt = ({ session, leaf }: { readonly session: string; readonly leaf: string | null }) => {
	const entries = Arr.filter(parseSessionEntries(session), (entry): entry is SessionEntry => entry.type !== "session");

	if (!Arr.some(entries, ({ id }) => id === leaf)) {
		return Effect.succeedNone;
	}

	const { messages } = buildSessionContext(entries, leaf);

	return Effect.asSome(transcriptOf(convertToLlm(messages)));
};

const strictQuestion = {
	type: "bool",
	instructions:
		"`conversation` is a whole conversation between a software developer and a coding agent: messages, pasted text, tool calls and file or command output. Does it contain protected health information anywhere: any identifier of a person (any of the 18 HIPAA Safe Harbor classes: name; street address, city, county, ZIP code or any place smaller than a state; any date tied to the person other than a year, or an age over 89; phone number; fax number; email address; Social Security number; medical record number; health plan beneficiary number; account number; certificate or license number; vehicle identifier or license plate; device identifier or serial number; URL; IP address; fingerprint, voiceprint or other biometric; full-face photo or comparable image; any other unique identifying number, characteristic or code) together with, or in a record about, anything about that person's health, condition, care, treatment, medication, insurance or payment for care? Count identifiers and health facts that are encoded (base64, hex, URL-encoded, escaped), split across messages or lines, misspelled, abbreviated, translated, minified, or buried in logs, fixtures, test data or files. If there is any doubt at all, answer true.",
	criteria: {
		true: "It contains, likely contains, or might contain health, care, insurance or payment information tied to an identifiable person.",
		false: "It certainly contains no identifiable person's health, care, insurance or payment information: only code, schemas or field names without values, generic medical terms, placeholders, or public figures with no health record.",
	},
} as const;

const phiThreshold = 0.05;

type Verdict = "clean" | "phi" | "no-session" | "no-leaf" | "unreadable" | "judge-error";

const textOf = (transcript: Transcript) =>
	Arr.join(
		Arr.flatMap(transcript, ({ role, parts }) =>
			Arr.flatMap(parts, (part) => (part.kind === "text" ? [`[${role}] ${part.text}`] : [])),
		),
		"\n",
	);

const verdictOf = (result: ClassifierResult): Verdict => {
	const answer = result.answers["phi"];

	if (result.stopReason !== "stop" || answer?.type !== "bool") {
		return "judge-error";
	}

	return answer.probability >= phiThreshold ? "phi" : "clean";
};

const judge = (classify: Classify, transcript: Transcript): Effect.Effect<Verdict> => {
	if (Arr.some(transcript, ({ parts }) => Arr.some(parts, (part) => part.kind === "image"))) {
		return Effect.succeed("phi");
	}

	const context = { state: { conversation: textOf(transcript) }, questions: { phi: strictQuestion } };

	return Effect.tryPromise({
		try: () => classify(context, { timeoutMs: 120_000 }),
		catch: () => JudgeFailed.make({ why: "error" }),
	}).pipe(
		Effect.map(verdictOf),
		Effect.orElseSucceed((): Verdict => "judge-error"),
	);
};

interface Audit<ReadError> extends Sampling {
	readonly lanes: Lanes;
	readonly readSession: (session: string) => Effect.Effect<Option.Option<string>, ReadError>;
	readonly classify: Classify;
}

const relabelOne =
	<ReadError>({ readSession, classify }: Audit<ReadError>) =>
	(lane: Lane) =>
		Effect.gen(function* () {
			const session = yield* readSession(lane.session);

			if (Option.isNone(session)) {
				return "no-session";
			}

			const conversation = yield* Effect.option(conversationAt({ session: session.value, leaf: lane.leaf }));

			return yield* Option.match(Option.flatten(conversation), {
				onNone: (): Effect.Effect<Verdict> =>
					Effect.succeed(Option.isNone(conversation) ? "unreadable" : "no-leaf"),
				onSome: (transcript) => judge(classify, transcript),
			});
		});

const shareLine = (records: ReadonlyArray<Lane>) => {
	const { personal, routed } = personalShare(records);

	if (routed === 0) {
		return "would-be-personal share: no routed requests";
	}

	return `would-be-personal share: ${((personal / routed) * 100).toFixed(2)}% (${String(personal)} of ${String(routed)} routed request characters, direct requests excluded)`;
};

const verdictLine = ({ session, leaf }: Lane, verdict: Verdict) => {
	const where = `session ${session} leaf ${leaf ?? "none"}`;

	if (verdict === "clean") {
		return [];
	}

	return [verdict === "phi" ? `disagree: ${where}` : `unjudged (${verdict}): ${where}`];
};

const summaryLine = (verdicts: ReadonlyArray<Verdict>) => {
	const agreed = Arr.length(Arr.filter(verdicts, (verdict) => verdict === "clean"));
	const disagreed = Arr.length(Arr.filter(verdicts, (verdict) => verdict === "phi"));

	return `sampled ${String(verdicts.length)}, agreed ${String(agreed)}, disagreed ${String(disagreed)}, unjudged ${String(verdicts.length - agreed - disagreed)}`;
};

export const audit = <ReadError>(input: Audit<ReadError>) =>
	Effect.gen(function* () {
		const { lanes, seed } = input;
		const sampled = yield* sampleOf({ ...input, records: lanes.records });
		const verdicts = yield* Effect.forEach(sampled, relabelOne(input), { concurrency: 4 });
		const pool = Arr.length(Arr.filter(lanes.records, wouldGoPersonal));

		const relabelled = Arr.isReadonlyArrayEmpty(sampled)
			? ["no would-be-personal records: nothing to relabel"]
			: [
					`relabel: ${String(sampled.length)} of ${String(pool)} would-be-personal records, seed ${String(seed)}. Session files hold no system prompt, so each conversation is judged without it.`,
					...Arr.flatten(Arr.zipWith(sampled, verdicts, verdictLine)),
					summaryLine(verdicts),
				];

		return {
			lines: [
				`lane records: ${String(lanes.records.length)}, undecodable lines: ${String(lanes.undecodable.length)}`,
				...Arr.map(lanes.undecodable, ({ file, line }) => `undecodable lane line: ${file}:${String(line)}`),
				shareLine(lanes.records),
				...relabelled,
			],
			passed: Arr.isReadonlyArrayEmpty(lanes.undecodable) && Arr.every(verdicts, (verdict) => verdict === "clean"),
		};
	});

/** Sorted by name, so a seed picks the same sample however the folder lists. */
const readLaneFiles = Effect.fn("readLaneFiles")(function* (folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const names = (yield* fs.exists(folder)) ? yield* fs.readDirectory(folder) : [];
	const logs = Arr.sort(Arr.filter(names, Str.endsWith(".jsonl")), Str.Order);

	return yield* Effect.forEach(logs, (name) =>
		Effect.map(fs.readFileString(`${folder}/${name}`), (text) => ({ name, text })),
	);
});

/** Pi names a session file `<timestamp>_<session id>.jsonl`; owned-work puts delegates' in a `delegates/` folder below. */
const sessionReader = Effect.fn("sessionReader")(function* (home: string) {
	const fs = yield* FileSystem.FileSystem;
	const folder = `${home}/.pi/agent/sessions`;
	const names = (yield* fs.exists(folder)) ? yield* fs.readDirectory(folder, { recursive: true }) : [];

	return (session: string) =>
		Option.match(Arr.findFirst(names, Str.endsWith(`_${session}.jsonl`)), {
			onNone: () => Effect.succeedNone,
			onSome: (name) => Effect.asSome(fs.readFileString(`${folder}/${name}`)),
		});
});

const decisionsOn = Effect.fn("decisionsOn")(function* (home: string) {
	const options = { authPath: `${home}/.pi/agent/auth.json`, modelsPath: `${home}/.pi/agent/models.json` };
	const runtime = yield* Effect.promise(() => ModelRuntime.create(options));
	const registry = new ModelRegistry(runtime);
	const classifier = Option.fromUndefinedOr(registry.findOfType("classifier", "openai", decisionsModel));

	const classify: Classify = (context, timeout) =>
		Option.match(classifier, {
			onNone: () => Promise.reject(new Error(`no classifier openai/${decisionsModel}`)),
			onSome: (model) => registry.classify(model, context, timeout),
		});

	return classify;
});

class RelabelFailed extends Schema.TaggedError<RelabelFailed, { readonly brand: unique symbol }>()(
	"RelabelFailed",
	{},
) {
	override readonly [Runtime.errorReported] = false;
}

const relabel = Effect.fn("relabel")(function* (sampling: Sampling) {
	const folder = yield* lanesFolder;
	const files = yield* readLaneFiles(folder);

	if (Arr.isReadonlyArrayEmpty(files)) {
		return yield* Console.log(`found no lane logs in ${folder}`);
	}

	const home = yield* Config.String("HOME");
	const readSession = yield* sessionReader(home);
	const classify = yield* decisionsOn(home);
	const report = yield* audit({ lanes: parseLanes(files), readSession, classify, ...sampling });

	yield* Console.log(Arr.join(report.lines, "\n"));

	return yield* report.passed ? Effect.void : Effect.fail(RelabelFailed.make({}));
});

if (import.meta.main) {
	const flags = {
		size: Flag.Int("sample").pipe(Flag.withDefault(50)),
		seed: Flag.Int("seed").pipe(Flag.withDefault(1)),
	};

	NodeRuntime.runMain(
		Command.run(Command.make("relabel", flags, relabel), { version: "1" }).pipe(Effect.provide(NodeServices.layer)),
	);
}
