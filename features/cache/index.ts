import type { AssistantMessage, SystemMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";

/** The custom entry just before each reply that missed. pi never puts a custom entry in the model's context. */
export const entryKind = "pi.cache-miss";

/** The cache lifetime of Anthropic's default retention, which pi's own cache notices also assume. */
const cacheTtlMs = 5 * 60 * 1000;

/** Fewer unread cached tokens make a small miss, not a full-price rewrite worth a record. */
const minMissed = 50_000;

export const Cause = Schema.TaggedUnion({
	Idle: { ms: Schema.Finite },
	ModelChanged: { from: Schema.String, to: Schema.String },
	Compacted: {},
	ContextEdited: {},
	PromptChanged: {},
	ToolsChanged: {},
});

export type Cause = typeof Cause.Type;

/** A reply that rewrote its cached prompt at full price, and every cause that held. Empty causes: nothing here explains it. */
export const Miss = Schema.Struct({
	missedTokens: Schema.Finite,
	cacheRead: Schema.Finite,
	prompt: Schema.Finite,
	causes: Schema.Array(Cause),
});

export type Miss = typeof Miss.Type;

/** A model call on the branch: a reply, or a cache-warm call. */
interface Call {
	readonly at: number;
	readonly model: string;
	readonly usage: Usage;
}

const promptOf = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite;

const usedCache = (usage: Usage) => usage.cacheRead + usage.cacheWrite > 0;

/** A failed call reports no prompt, so it reached no cache. */
const callOf = (entry: SessionEntry): Option.Option<Call> => {
	if (entry.type === "message" && entry.message.role === "assistant" && promptOf(entry.message.usage) > 0) {
		const { timestamp, provider, model, usage } = entry.message;

		return Option.some({ at: timestamp, model: `${provider}/${model}`, usage });
	}

	if (entry.type === "usage" && entry.kind === "cache_warm" && promptOf(entry.usage) > 0) {
		const { timestamp, provider, model, usage } = entry;

		return Option.some({ at: Date.parse(timestamp), model: `${provider}/${model}`, usage });
	}

	return Option.none();
};

/** The last call on the branch, and the entries after it. */
interface Last {
	readonly call: Call;
	readonly since: ReadonlyArray<SessionEntry>;
}

const lastCall = (branch: ReadonlyArray<SessionEntry>): Option.Option<Last> =>
	Arr.findLast(branch, (entry, index) =>
		Option.map(callOf(entry), (call) => ({ call, since: branch.slice(index + 1) })),
	);

/**
 * The system messages pi saves for each change to the prompt sections or the declared tools. A change pi makes only in
 * the request, a `systemPrompt` a `before_agent_start` handler returns or a declaration `prepareLoadout` hides, saves
 * none, so its miss names no cause. A forced `systemPrompt` also hides the section changes pi saves, which still name
 * PromptChanged. This harness makes neither change.
 */
const systemMessages = (entries: ReadonlyArray<SessionEntry>): ReadonlyArray<SystemMessage> =>
	Arr.getSomes(
		Arr.map(entries, (entry) =>
			entry.type === "message" && entry.message.role === "system" ? Option.some(entry.message) : Option.none(),
		),
	);

const changesPrompt = ({ content, sections }: SystemMessage) =>
	content.length > 0 || !Rec.isEmptyRecord(sections ?? {});

const changesTools = ({ toolsAdded, toolsRemoved }: SystemMessage) =>
	Arr.isReadonlyArrayNonEmpty(toolsAdded ?? []) || Arr.isReadonlyArrayNonEmpty(toolsRemoved ?? []);

/** Every cause that held between the last call and the reply. */
const causesOf = (reply: AssistantMessage, { call, since }: Last) => {
	const idleMs = reply.timestamp - call.at;
	const model = `${reply.provider}/${reply.model}`;
	const changes = systemMessages(since);
	const { cases } = Cause;

	const held: ReadonlyArray<readonly [boolean, Cause]> = [
		[idleMs > cacheTtlMs, cases.Idle.make({ ms: idleMs })],
		[model !== call.model, cases.ModelChanged.make({ from: call.model, to: model })],
		[Arr.some(since, (entry) => entry.type === "compaction"), cases.Compacted.make({})],
		[Arr.some(since, (entry) => entry.type === "context_edit"), cases.ContextEdited.make({})],
		[Arr.some(changes, changesPrompt), cases.PromptChanged.make({})],
		[Arr.some(changes, changesTools), cases.ToolsChanged.make({})],
	];

	return Arr.map(
		Arr.filter(held, ([holds]) => holds),
		([, cause]) => cause,
	);
};

/**
 * A reply missed when it left at least 50,000 tokens unread that the last call had cached: the smaller of the two
 * prompts, less what the reply read. A cache shows only once a call on the branch, or the reply, reads or writes it,
 * since a provider without caching reports neither. A session's first call has nothing cached to miss.
 */
const missOf = (branch: ReadonlyArray<SessionEntry>, reply: AssistantMessage): Option.Option<Miss> => {
	const { cacheRead } = reply.usage;
	const prompt = promptOf(reply.usage);

	const cacheShown =
		usedCache(reply.usage) ||
		Arr.some(branch, (entry) => Option.exists(callOf(entry), ({ usage }) => usedCache(usage)));

	return Option.flatMap(lastCall(branch), (last) => {
		const missedTokens = Math.min(promptOf(last.call.usage), prompt) - cacheRead;

		if (!cacheShown || missedTokens < minMissed) {
			return Option.none();
		}

		return Option.some({ missedTokens, cacheRead, prompt, causes: causesOf(reply, last) });
	});
};

/** The `message_end` handler. pi calls it before it saves the reply, so the branch holds what came before. */
export const recordMisses =
	(pi: Pick<ExtensionAPI, "appendEntry">) =>
	({ message }: MessageEndEvent, ctx: Pick<ExtensionContext, "sessionManager">) => {
		if (message.role !== "assistant") {
			return;
		}

		const miss = missOf(ctx.sessionManager.getBranch(), message);

		if (Option.isSome(miss)) {
			pi.appendEntry(entryKind, miss.value);
		}
	};

/**
 * Records why a reply paid full price to rewrite the prompt cache. pi works out a miss only for its TUI notice and keeps
 * none of it. This records nothing else and changes no cache setting.
 */
export const cache = (pi: Pick<ExtensionAPI, "on" | "appendEntry">) => {
	pi.on("message_end", recordMisses(pi));
};
