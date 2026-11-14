import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionEntry,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The custom entry just before each reply that missed. pi never puts a custom entry in the model's context. */
export const entryKind = "pi.cache-miss";

/** The cache lifetime of Anthropic's default retention, which pi's own cache notices also assume. */
const cacheTtlMs = 5 * 60 * 1000;

/** A smaller prompt is a small cold start, not a full-price rewrite worth a record. */
const minPrompt = 50_000;

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

/** The last call that wrote or refreshed this session's cache: a reply, or a cache-warm call after it. */
interface Touch {
	readonly at: number;
	readonly model: string;
	readonly prompt: number;
}

/** What a request sends ahead of the conversation. A change in either rewrites the cache. */
interface Prefix {
	readonly systemPrompt: string;
	readonly tools: ReadonlyArray<Pick<ToolInfo, "name" | "description" | "parameters">>;
}

const promptOf = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite;

const callOf = (entry: SessionEntry): Option.Option<Touch> => {
	if (entry.type === "message" && entry.message.role === "assistant") {
		const { timestamp, provider, model, usage } = entry.message;

		return Option.some({ at: timestamp, model: `${provider}/${model}`, prompt: promptOf(usage) });
	}

	if (entry.type === "usage" && entry.kind === "cache_warm") {
		const { timestamp, provider, model, usage } = entry;

		return Option.some({ at: Date.parse(timestamp), model: `${provider}/${model}`, prompt: promptOf(usage) });
	}

	return Option.none();
};

/** A failed call reports no prompt and touched nothing. */
const touchOf = (entry: SessionEntry) => Option.filter(callOf(entry), ({ prompt }) => prompt > 0);

/** The last touch on the branch, and the entries after it. */
const lastTouch = (branch: ReadonlyArray<SessionEntry>) =>
	Arr.findLast(branch, (entry, index) =>
		Option.map(touchOf(entry), (touch) => ({ touch, since: branch.slice(index + 1) })),
	);

/**
 * A reply missed when its prompt is at least 50,000 tokens and it read at most max(1,000, 1% of the prompt) from the
 * cache, the retro's own threshold. A session's first call has nothing cached to miss. `before` is the prefix of the
 * previous reply, unknown after a start or a reload.
 */
const missOf = ({
	branch,
	reply,
	before,
	now,
}: {
	readonly branch: ReadonlyArray<SessionEntry>;
	readonly reply: AssistantMessage;
	readonly before: Option.Option<Prefix>;
	readonly now: Prefix;
}): Option.Option<Miss> => {
	const { cacheRead } = reply.usage;
	const prompt = promptOf(reply.usage);

	if (prompt < minPrompt || cacheRead > Math.max(1000, prompt / 100)) {
		return Option.none();
	}

	return Option.map(lastTouch(branch), ({ touch, since }) => {
		const idleMs = reply.timestamp - touch.at;
		const model = `${reply.provider}/${reply.model}`;

		const { cases } = Cause;

		const held: ReadonlyArray<readonly [boolean, Cause]> = [
			[idleMs > cacheTtlMs, cases.Idle.make({ ms: idleMs })],
			[model !== touch.model, cases.ModelChanged.make({ from: touch.model, to: model })],
			[Arr.some(since, (entry) => entry.type === "compaction"), cases.Compacted.make({})],
			[Arr.some(since, (entry) => entry.type === "context_edit"), cases.ContextEdited.make({})],
			[Option.exists(before, ({ systemPrompt }) => systemPrompt !== now.systemPrompt), cases.PromptChanged.make({})],
			[Option.exists(before, ({ tools }) => !Equal.equals(tools, now.tools)), cases.ToolsChanged.make({})],
		];

		return {
			missedTokens: Math.min(touch.prompt, prompt) - cacheRead,
			cacheRead,
			prompt,
			causes: Arr.map(
				Arr.filter(held, ([holds]) => holds),
				([, cause]) => cause,
			),
		};
	});
};

type Host = Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "getAllTools">;

/** The active tools as the model sees them. */
const toolsOf = (pi: Host) => {
	const active = new Set(pi.getActiveTools());
	const declared = Arr.filter(pi.getAllTools(), ({ name }) => active.has(name));

	return Arr.map(declared, ({ name, description, parameters }) => ({ name, description, parameters }));
};

/** The `message_end` handler. pi calls it before it saves the reply, so the branch holds what came before. */
export const recordMisses = (pi: Host) => {
	let before: Option.Option<Prefix> = Option.none();

	return ({ message }: MessageEndEvent, ctx: Pick<ExtensionContext, "sessionManager" | "getSystemPrompt">) => {
		if (message.role !== "assistant") {
			return;
		}

		const now = { systemPrompt: ctx.getSystemPrompt(), tools: toolsOf(pi) };
		const miss = missOf({ branch: ctx.sessionManager.getBranch(), reply: message, before, now });

		before = Option.some(now);

		if (Option.isSome(miss)) {
			pi.appendEntry(entryKind, miss.value);
		}
	};
};

/**
 * Records why a reply paid full price to rewrite the prompt cache. pi works out a miss only for its TUI notice and keeps
 * none of it. This records nothing else and changes no cache setting.
 */
export const cache = (pi: Host & Pick<ExtensionAPI, "on">) => {
	pi.on("message_end", recordMisses(pi));
};
