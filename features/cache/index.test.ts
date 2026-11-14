import { expect, test } from "bun:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ToolInfo } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Type } from "typebox";

import { Cause, entryKind, Miss, recordMisses } from "./index.ts";

const minute = 60_000;

const start = Date.parse("2026-01-01T09:00:00Z");

const { cases: cause } = Cause;

const idle = cause.Idle.make({ ms: 6 * minute });

const haiku = cause.ModelChanged.make({ from: "ultra-a/claude-opus-5-5", to: "ultra-a/claude-haiku-5-5" });

const toolOf = (name: string): ToolInfo => ({
	name,
	description: `The ${name} tool.`,
	parameters: Type.Object({}),
	exposure: "direct",
	sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" },
});

interface Call {
	readonly at: number;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite?: number;
	readonly model?: string;
}

/** A 100,000-token prompt read from the cache, and the same prompt rewritten at full price. */
const hit = { input: 1000, cacheRead: 99_000 };
const full = { input: 100_000, cacheRead: 0 };

const usageOf = ({ input, cacheRead, cacheWrite = 0 }: Call) => ({
	input,
	output: 100,
	cacheRead,
	cacheWrite,
	totalTokens: input + cacheRead + cacheWrite + 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const replyOf = (call: Call): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "Done." }],
	api: "anthropic-messages",
	provider: "ultra-a",
	model: call.model ?? "claude-opus-5-5",
	usage: usageOf(call),
	stopReason: "stop",
	timestamp: call.at,
});

const decodeMiss = Schema.decodeUnknownOption(Miss);

/** A session whose replies pass through the handler before pi saves them, as in a running pi. */
const world = () => {
	const session = SessionManager.inMemory("/work");
	const prefix = { systemPrompt: "You are a coding agent.", active: ["read"] };
	const tools = [toolOf("read"), toolOf("bash")];

	const record = recordMisses({
		appendEntry: (customType, data) => {
			session.appendCustomEntry(customType, data);
		},
		getActiveTools: () => prefix.active,
		getAllTools: () => tools,
	});

	const reply = (call: Call) => {
		const message = replyOf(call);

		record({ type: "message_end", message }, { sessionManager: session, getSystemPrompt: () => prefix.systemPrompt });

		return session.appendMessage(message);
	};

	const misses = () =>
		Arr.getSomes(
			Arr.map(session.getEntries(), (entry) =>
				entry.type === "custom" && entry.customType === entryKind ? decodeMiss(entry.data) : Option.none(),
			),
		);

	return { session, prefix, reply, misses };
};

type World = ReturnType<typeof world>;

/** A miss of a prompt rewritten whole, or of only the part an earlier, shorter prompt had cached. */
const missed = (causes: Miss["causes"], prompt = 100_000, missedTokens = prompt): ReadonlyArray<Miss> => [
	{ missedTokens, cacheRead: 0, prompt, causes },
];

const cases: ReadonlyArray<readonly [string, (world: World) => void, ReadonlyArray<Miss>]> = [
	[
		"idle past the cache lifetime",
		({ reply }) => {
			reply({ at: start, ...hit });
			reply({ at: start + 6 * minute, ...full });
		},
		missed([idle]),
	],
	[
		"a model change",
		({ reply }) => {
			reply({ at: start, ...hit });
			reply({ at: start + minute, ...full, model: "claude-haiku-5-5" });
		},
		missed([haiku]),
	],
	[
		"a compaction",
		({ session, reply }) => {
			const first = reply({ at: start, ...hit });

			session.appendCompaction("summary", first, 100_000);
			reply({ at: start + minute, input: 60_000, cacheRead: 0 });
		},
		missed([cause.Compacted.make({})], 60_000),
	],
	[
		"a context edit",
		({ session, reply }) => {
			const first = reply({ at: start, ...hit });

			session.appendContextEdit(first, { content: "Edited." });
			reply({ at: start + minute, ...full });
		},
		missed([cause.ContextEdited.make({})]),
	],
	[
		"a changed system prompt",
		({ prefix, reply }) => {
			reply({ at: start, ...hit });
			prefix.systemPrompt = "You are a reviewer.";
			reply({ at: start + minute, ...full });
		},
		missed([cause.PromptChanged.make({})]),
	],
	[
		"a system prompt change made before a failed call",
		({ prefix, reply }) => {
			reply({ at: start, ...hit });
			prefix.systemPrompt = "You are a reviewer.";
			reply({ at: start + minute, input: 0, cacheRead: 0 });
			reply({ at: start + 2 * minute, ...full });
		},
		missed([cause.PromptChanged.make({})]),
	],
	[
		"changed tools",
		({ prefix, reply }) => {
			reply({ at: start, ...hit });
			prefix.active = ["read", "bash"];
			reply({ at: start + minute, ...full });
		},
		missed([cause.ToolsChanged.make({})]),
	],
	[
		"two causes together",
		({ reply }) => {
			reply({ at: start, ...hit });
			reply({ at: start + 6 * minute, ...full, model: "claude-haiku-5-5" });
		},
		missed([idle, haiku]),
	],
	[
		"a miss nothing explains, with an empty list",
		({ reply }) => {
			reply({ at: start, input: 1000, cacheRead: 59_000 });
			reply({ at: start + minute, ...full });
		},
		missed([], 100_000, 60_000),
	],
	[
		"idle counted from the last cache-warm call, not the last reply",
		({ session, reply }) => {
			reply({ at: start, ...hit });

			const warm = session.appendUsage("cache_warm", "ultra-a", "claude-opus-5-5", usageOf({ at: 0, ...hit }));

			reply({ at: Date.parse(warm.timestamp) + minute, ...full });
		},
		missed([]),
	],
	[
		"a partial miss of 50,000 tokens",
		({ reply }) => {
			reply({ at: start, ...hit });
			reply({ at: start + minute, input: 50_000, cacheRead: 50_000 });
		},
		[{ missedTokens: 50_000, cacheRead: 50_000, prompt: 100_000, causes: [] }],
	],
	[
		"a full-price call that reports no cache use as the last call",
		({ reply }) => {
			reply({ at: start, ...hit });
			reply({ at: start + 6 * minute, ...full });
			reply({ at: start + 7 * minute, ...full });
		},
		[...missed([idle]), ...missed([])],
	],
	[
		"no prompt change after /tree returns to a reply sent with the same prompt",
		({ session, prefix, reply }) => {
			const first = reply({ at: start, ...hit });

			prefix.systemPrompt = "You are a reviewer.";
			reply({ at: start + minute, ...hit });
			session.branch(first);
			prefix.systemPrompt = "You are a coding agent.";
			reply({ at: start + 2 * minute, ...full });
		},
		missed([]),
	],
	[
		"nothing when fewer than 50,000 cached tokens went unread",
		({ reply }) => {
			reply({ at: start, ...hit });
			reply({ at: start + 6 * minute, input: 49_999, cacheRead: 50_001 });
		},
		[],
	],
	[
		"nothing for a prompt that grew far past a small cache",
		({ reply }) => {
			reply({ at: start, input: 36, cacheRead: 1500 });
			reply({ at: start + minute, input: 253_952, cacheRead: 2048 });
		},
		[],
	],
	[
		"nothing when no call reported using the cache",
		({ reply }) => {
			reply({ at: start, ...full });
			reply({ at: start + 6 * minute, ...full });
		},
		[],
	],
	[
		"nothing for a session's first reply, which has no cache to miss",
		({ reply }) => {
			reply({ at: start, input: 0, cacheRead: 0, cacheWrite: 100_000 });
		},
		[],
	],
];

test.each(cases)("a reply records %s", (_name, play, expected) => {
	const scene = world();

	play(scene);

	expect(scene.misses()).toEqual([...expected]);
});

test("the model never sees a miss entry", () => {
	const { session, reply, misses } = world();

	reply({ at: start, ...hit });
	reply({ at: start + 6 * minute, ...full });

	const seen = Arr.map(session.buildSessionContext().messages, ({ role }) => role);

	expect(misses()).toHaveLength(1);
	expect(seen).toEqual(["assistant", "assistant"]);
});
