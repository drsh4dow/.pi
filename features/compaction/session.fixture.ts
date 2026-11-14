import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	DEFAULT_COMPACTION_SETTINGS,
	type FileOperations,
	type SessionBeforeCompactEvent,
	SessionManager,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { compaction, Details } from "./index.ts";

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

	const complete = (_model: Model<Api>, context: Context) => {
		prompts.push(serializeConversation(context.messages));

		return answers[prompts.length - 1]?.() ?? Promise.reject(new Error("the test gave no answer for this call"));
	};

	return { prompts, ctx: { model: getBuiltinModel("anthropic", "claude-opus-5-5"), modelRegistry: { complete } } };
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

export const eventFor = ({
	session,
	fileOps,
	reason = "threshold",
}: {
	readonly session: SessionManager;
	readonly fileOps: FileOperations;
	readonly reason?: SessionBeforeCompactEvent["reason"];
}): SessionBeforeCompactEvent => {
	const firstKeptEntryId = session.appendMessage({ role: "user", content: "Carry on.", timestamp: 0 });
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

export const compact = Effect.fn("compact")(function* (
	env: Readonly<Record<string, string>>,
	event: SessionBeforeCompactEvent,
	ctx: Ctx,
) {
	const handlers: Array<Handler> = [];

	compaction(env)({
		on: (_name, handler) => {
			handlers.push(handler);
		},
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

export const run = <Value, Failure>(effect: Effect.Effect<Value, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
