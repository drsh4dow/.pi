import { type Api, type Model, type Usage, uuidv7 } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type SessionEntry,
	serializeConversation,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { piHost } from "#src/client/pi-host/index.ts";
import { StateFolder, stateFolderLayer } from "#src/client/state-folder/index.ts";
import { guideFiles, readGuides } from "#src/features/loaded/index.ts";
import { selfFromEnv } from "#src/features/owned-work/index.ts";
import { internalIdsOnly, isPhi } from "#src/features/phi-router/index.ts";
import { lastFolder } from "#src/features/state-folder/index.ts";
import { guidesToRestore, noGuides } from "./guides.ts";
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

export { narrativeCap } from "./summary.ts";

type Env = Readonly<Record<string, string | undefined>>;

type StreamSimple = ExtensionContext["modelRegistry"]["streamSimple"];

/** `streamSimple`, unlike `complete`, routes a virtual model, as `direct`, so a PHI router sends the summary to its BAA account. */
interface Caller {
	readonly model: Model<Api> | undefined;
	readonly modelRegistry: {
		readonly streamSimple: (...args: Parameters<StreamSimple>) => Pick<ReturnType<StreamSimple>, "result">;
	};
}

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

		const stateFolder = yield* StateFolder;
		const path = `${folder.value}/STATE.md`;
		const text = yield* stateFolder.text(path);

		return Option.some(Anchor.State({ path, text }));
	},
	Effect.catchCause((cause) =>
		Effect.as(
			Effect.logWarning("the compaction summary carries no anchor, reading it failed", cause),
			Option.none<Anchor>(),
		),
	),
);

const guidesFor = Effect.fn("guidesFor")(
	function* (commands: ReadonlyArray<SlashCommandInfo>, event: SessionBeforeCompactEvent) {
		const paths = yield* guideFiles(commands);
		const files = yield* readGuides(paths);

		return guidesToRestore({
			files,
			branch: event.branchEntries,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
		});
	},
	Effect.catchCause((cause) =>
		Effect.as(Effect.logWarning("the compaction summary restores no guides, reading them failed", cause), noGuides),
	),
);

/** In a `phi` session a clean summary goes on to a personal account, so it names patients by internal id only. */
const systemPromptFor = (model: Model<Api>) => (isPhi(model) ? `${systemPrompt} ${internalIdsOnly}` : systemPrompt);

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
	readonly model: Model<Api>;
	readonly signal: AbortSignal;
	readonly text: string;
}) {
	const timestamp = yield* Clock.currentTimeMillis;

	const call = Effect.tryPromise({
		try: () =>
			ctx.modelRegistry
				.streamSimple(
					model,
					{
						systemPrompt: systemPromptFor(model),
						messages: [{ role: "user", content: [{ type: "text", text }], timestamp }],
					},
					{ signal, cacheRetention: "none", sessionId: uuidv7() },
				)
				.result(),
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

const compact = Effect.fn("compact")(function* ({
	env,
	commands,
	event,
	ctx,
}: {
	readonly env: Env;
	readonly commands: ReadonlyArray<SlashCommandInfo>;
	readonly event: SessionBeforeCompactEvent;
	readonly ctx: Caller;
}) {
	const { preparation, branchEntries } = event;
	const prior = priorOf({ branch: branchEntries, previousSummary: preparation.previousSummary });
	const anchor = yield* anchorOf(env, branchEntries);
	const guides = yield* guidesFor(commands, event);
	const { reply, usage } = yield* narrativeCall({ event, ctx, prior, anchor });
	const narrative = narrativeFrom({ reply, prior: prior.narrative });

	if (Narrative.$is("Carried")(narrative)) {
		yield* Effect.logWarning(`${carriedNote}, because ${narrative.reason}`);
	}

	const parts: Parts = {
		narrative,
		anchor,
		guides,
		files: filesOf({ prior: prior.files, fileOps: preparation.fileOps }),
	};

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
 * Always returns a compaction, since anything else lets pi's own prompt run, which carries every earlier summary into
 * the next.
 */
export const compaction =
	(env: Env) =>
	(pi: {
		readonly on: (
			event: "session_before_compact",
			handler: (event: SessionBeforeCompactEvent, ctx: Caller) => Promise<SessionBeforeCompactResult>,
		) => void;
		readonly getCommands: () => ReadonlyArray<SlashCommandInfo>;
	}) => {
		const host = piHost(Layer.provideMerge(stateFolderLayer, NodeServices.layer));

		pi.on("session_before_compact", (event, ctx) =>
			host.run(compact({ env, commands: pi.getCommands(), event, ctx })),
		);
	};
