import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	DEFAULT_COMPACTION_SETTINGS,
	type FileOperations,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	SessionManager,
	serializeConversation,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { compaction } from "./index.ts";
import { Details } from "./summary.ts";

type Handler = Parameters<Parameters<ReturnType<typeof compaction>>[0]["on"]>[1];

export type Ctx = Parameters<Handler>[1];

export const rootEnv = {};

export const delegateEnv = { PI_OWNED_WORK_LEVEL: "2", PI_OWNED_WORK_ROLE: "leaf", PI_OWNED_WORK_SLICE: "parser" };

export const task = "Fix the parser.";

const usage = (cost: number): Usage => ({
	input: 1000,
	output: 100,
	cacheRead: 10,
	cacheWrite: 1,
	totalTokens: 1111,
	cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

export const reply = ({
	text,
	stopReason = "stop",
	cost = 0.25,
}: {
	readonly text: string;
	readonly stopReason?: AssistantMessage["stopReason"];
	readonly cost?: number;
}): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	usage: usage(cost),
	stopReason,
	timestamp: 0,
});

export const modelWith = (answers: ReadonlyArray<() => Promise<AssistantMessage>>) => {
	const prompts: Array<string> = [];

	const streamSimple = (_model: Model<Api>, context: Context) => {
		prompts.push(serializeConversation(context.messages));

		const answer = answers[prompts.length - 1];

		return { result: () => answer?.() ?? Promise.reject(new Error("the test gave no answer for this call")) };
	};

	return { prompts, ctx: { model: getBuiltinModel("anthropic", "claude-opus-5-5"), modelRegistry: { streamSimple } } };
};

export const answering = (...messages: ReadonlyArray<AssistantMessage>) =>
	modelWith(Arr.map(messages, (message) => () => Promise.resolve(message)));

export const ops = ({
	read = [],
	edited = [],
	written = [],
}: Partial<Record<keyof FileOperations, ReadonlyArray<string>>>) => ({
	read: new Set(read),
	edited: new Set(edited),
	written: new Set(written),
});

export const readA = ops({ read: ["src/a.ts"] });

export const sessionWithTask = () => {
	const session = SessionManager.inMemory("/work");

	session.appendMessage({ role: "user", content: task, timestamp: 0 });

	return session;
};

export const readResult = ({ session, text }: { readonly session: SessionManager; readonly text: string }) =>
	session.appendMessage({
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	});

export const eventFor = ({
	session,
	fileOps,
	reason = "threshold",
	keptReads = [],
}: {
	readonly session: SessionManager;
	readonly fileOps: FileOperations;
	readonly reason?: SessionBeforeCompactEvent["reason"];
	readonly keptReads?: ReadonlyArray<string>;
}): SessionBeforeCompactEvent => {
	const firstKeptEntryId = session.appendMessage({ role: "user", content: "Carry on.", timestamp: 0 });

	for (const text of keptReads) {
		readResult({ session, text });
	}

	const branchEntries = session.getBranch();

	const preparation = {
		firstKeptEntryId,
		messagesToSummarize: [{ role: "user" as const, content: "Read src/a.ts and edit it.", timestamp: 0 }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 90_000,
		fileOps,
		settings: DEFAULT_COMPACTION_SETTINGS,
	};

	const previousSummary = Arr.findLast(branchEntries, (entry) =>
		entry.type === "compaction" ? Option.some(entry.summary) : Option.none(),
	);

	return {
		type: "session_before_compact",
		preparation: Option.match(previousSummary, {
			onNone: () => preparation,
			onSome: (summary) => ({ ...preparation, previousSummary: summary }),
		}),
		branchEntries,
		reason,
		willRetry: reason === "overflow",
		signal: new AbortController().signal,
	};
};

const skillCommand = (path: string): SlashCommandInfo => ({
	name: `skill:${path}`,
	source: "skill",
	sourceInfo: { path, source: "local", scope: "user", origin: "top-level" },
});

export const compact = Effect.fn("compact")(function* (
	env: Readonly<Record<string, string>>,
	event: SessionBeforeCompactEvent,
	ctx: Ctx,
	skills: ReadonlyArray<string> = [],
) {
	const handlers: Array<Handler> = [];

	compaction(env)({
		on: (_name, handler) => {
			handlers.push(handler);
		},
		getCommands: () => Arr.map(skills, skillCommand),
	});

	const results = yield* Effect.forEach(handlers, (handler) => Effect.promise(() => handler(event, ctx)));
	const entry = Arr.last(results).pipe(Option.flatMap(({ compaction: found }) => Option.fromNullishOr(found)));
	const details = yield* Schema.decodeUnknownEffect(Details)(Option.getOrUndefined(entry)?.details);

	return { ...Option.getOrThrow(entry), details };
});

export const record = ({
	session,
	entry,
}: {
	readonly session: SessionManager;
	readonly entry: Effect.Success<ReturnType<typeof compact>>;
}) => session.appendCompaction(entry.summary, entry.firstKeptEntryId, 90_000, entry.details, true, entry.usage);

export const sessionWithPrior = () => {
	const session = sessionWithTask();
	const narrative = "Prior narrative.";

	record({
		session,
		entry: {
			summary: `${narrative}\n\n<task>\n${task}\n</task>`,
			firstKeptEntryId: session.appendMessage({ role: "user", content: "Go on.", timestamp: 0 }),
			tokensBefore: 90_000,
			details: { narrative, readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
		},
	});

	return session;
};

const Compaction = Schema.Struct({
	type: Schema.Literal("compaction"),
	id: Schema.String,
	summary: Schema.String,
	firstKeptEntryId: Schema.String,
	details: Details,
});

export type Compaction = typeof Compaction.Type;

const decodeCompaction = Schema.decodeUnknownOption(Compaction);

const jsonOf = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const compactionsIn = (entries: ReadonlyArray<SessionEntry>) =>
	Arr.getSomes(Arr.map(entries, (entry) => decodeCompaction(entry)));

export const keptHolds = ({
	entries,
	last,
	text,
}: {
	readonly entries: ReadonlyArray<SessionEntry>;
	readonly last: Compaction;
	readonly text: string;
}) => {
	const fromFirst = Arr.dropWhile(entries, (entry) => entry.id !== last.firstKeptEntryId);
	const kept = Arr.takeWhile(fromFirst, (entry) => entry.id !== last.id);

	return (
		!Arr.isReadonlyArrayNonEmpty(kept) || Arr.some(kept, (entry) => Option.exists(jsonOf(entry), Str.includes(text)))
	);
};

export const run = <Value, Failure>(effect: Effect.Effect<Value, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
