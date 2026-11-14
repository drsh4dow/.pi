import { type Usage, uuidv7 } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type SessionEntry,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { selfFromEnv } from "../owned-work/index.ts";
import { lastFolder } from "../state-folder/index.ts";
import {
	Anchor,
	carriedNote,
	detailsOf,
	filesOf,
	Narrative,
	narrativeFrom,
	type Parts,
	type Prior,
	priorOf,
	promptOf,
	Reply,
	replyOf,
	summaryOf,
	systemPrompt,
	taskOf,
	totalUsage,
} from "./summary.ts";

export { carriedNote, Details, narrativeCap } from "./summary.ts";

type Env = Readonly<Record<string, string | undefined>>;

type Caller = Pick<ExtensionContext, "model"> & {
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "complete">;
};

const anchorOf = Effect.fn("anchorOf")(
	function* (env: Env, branch: ReadonlyArray<SessionEntry>) {
		const { role } = yield* selfFromEnv(env);

		if (role !== "root") {
			return taskOf(branch);
		}

		const folder = lastFolder(branch);

		if (Option.isNone(folder)) {
			return Option.none();
		}

		const fs = yield* FileSystem.FileSystem;
		const path = `${folder.value}/STATE.md`;
		const text = yield* fs.readFileString(path);

		return Option.some(Anchor.State({ path, text }));
	},
	Effect.catchCause((cause) =>
		Effect.as(
			Effect.logWarning("the compaction summary carries no anchor, reading it failed", cause),
			Option.none<Anchor>(),
		),
	),
);

interface Attempt {
	readonly reply: Reply;
	readonly usage: ReadonlyArray<Usage>;
}

const attempt = Effect.fn("attempt")(function* ({
	ctx,
	model,
	signal,
	text,
}: {
	readonly ctx: Caller;
	readonly model: NonNullable<Caller["model"]>;
	readonly signal: AbortSignal;
	readonly text: string;
}) {
	const timestamp = yield* Clock.currentTimeMillis;

	const call = Effect.tryPromise({
		try: () =>
			ctx.modelRegistry.complete(
				model,
				{ systemPrompt, messages: [{ role: "user", content: [{ type: "text", text }], timestamp }] },
				{ signal, cacheRetention: "none", sessionId: uuidv7() },
			),
		catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
	});

	return yield* Effect.match(call, {
		onFailure: (error): Attempt => ({
			reply: Reply.Failed({ reason: `the model call failed: ${error}` }),
			usage: [],
		}),
		onSuccess: (message): Attempt => ({ reply: replyOf(message), usage: [message.usage] }),
	});
});

const retryingOver = Effect.fn("retryingOver")(function* (
	ask: (overrun: Option.Option<number>) => Effect.Effect<Attempt>,
) {
	const first = yield* ask(Option.none());

	if (!Reply.$is("Over")(first.reply)) {
		return first;
	}

	const second = yield* ask(Option.some(first.reply.chars));

	return { reply: second.reply, usage: [...first.usage, ...second.usage] };
});

const narrativeCall = Effect.fn("narrativeCall")(
	function* ({
		event,
		ctx,
		prior,
		anchor,
	}: {
		readonly event: SessionBeforeCompactEvent;
		readonly ctx: Caller;
		readonly prior: Prior;
		readonly anchor: Option.Option<Anchor>;
	}) {
		const { model } = ctx;

		if (model === undefined) {
			return { reply: Reply.Failed({ reason: "the session has no model" }), usage: [] };
		}

		const { messagesToSummarize, turnPrefixMessages } = event.preparation;
		const conversation = serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages]));
		const customInstructions = Option.fromNullishOr(event.customInstructions);

		return yield* retryingOver((overrun) =>
			attempt({
				ctx,
				model,
				signal: event.signal,
				text: promptOf({ prior: prior.narrative, conversation, anchor, customInstructions, overrun }),
			}),
		);
	},
	Effect.catchCause((cause) =>
		Effect.succeed<Attempt>({ reply: Reply.Failed({ reason: `writing it failed: ${String(cause)}` }), usage: [] }),
	),
);

const compact = Effect.fn("compact")(function* (env: Env, event: SessionBeforeCompactEvent, ctx: Caller) {
	const { preparation, branchEntries } = event;
	const prior = priorOf({ branch: branchEntries, previousSummary: preparation.previousSummary });
	const anchor = yield* anchorOf(env, branchEntries);
	const { reply, usage } = yield* narrativeCall({ event, ctx, prior, anchor });
	const narrative = narrativeFrom({ reply, prior: prior.narrative });

	if (Narrative.$is("Carried")(narrative)) {
		yield* Effect.logWarning(`${carriedNote}, because ${narrative.reason}`);
	}

	const parts: Parts = { narrative, anchor, files: filesOf({ prior: prior.files, fileOps: preparation.fileOps }) };

	return {
		compaction: {
			summary: summaryOf(parts),
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			usage: totalUsage(usage),
			details: detailsOf(parts),
		},
	};
});

/**
 * The one `session_before_compact` handler, in the root and in every delegate. It writes the whole compaction: a
 * bounded narrative on the session's model under our own prompt, the anchor, and the file lists. It always returns a
 * compaction, since anything else lets pi's own prompt run, which carries every earlier summary into the next.
 */
export const compaction =
	(env: Env) =>
	(pi: {
		readonly on: (
			event: "session_before_compact",
			handler: (event: SessionBeforeCompactEvent, ctx: Caller) => Promise<SessionBeforeCompactResult>,
		) => void;
	}) => {
		pi.on("session_before_compact", (event, ctx) =>
			Effect.runPromise(compact(env, event, ctx).pipe(Effect.provide(NodeServices.layer))),
		);
	};
