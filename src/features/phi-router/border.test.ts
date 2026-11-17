import { expect, test } from "bun:test";

import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type ProviderStreams,
	type SystemMessage,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { guard, guardedApi, type Lookup, type Scope, type Seal } from "./border.ts";
import { partsOf, type Slot } from "./parts.ts";
import type { ContentKey } from "./policy/engine.ts";
import { stubs } from "./policy/policy.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const reply = (provider: string, content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider,
	model: "claude-opus-5-5",
	usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
	stopReason: "toolUse",
	timestamp: 3,
});

const asked: UserMessage = { role: "user", content: "Why does the eligibility import drop row 88123?", timestamp: 1 };

const pasted: UserMessage = {
	role: "user",
	content: [
		{ type: "text", text: "Member Rosalind Fairweather, DOB 1957-02-11" },
		{ type: "image", mimeType: "image/png", data: "c2Nhbg==" },
	],
	timestamp: 2,
};

const read: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "toolu_7",
	toolName: "read",
	content: [{ type: "text", text: "PID|1||MRN-55120||FAIRWEATHER^ROSALIND||19570211" }],
	details: { path: "fixtures/adt.hl7" },
	isError: false,
	timestamp: 4,
};

const thinking = { type: "thinking", thinking: "The row names Rosalind Fairweather." } as const;

const call = { type: "toolCall", id: "toolu_7", name: "read", arguments: { path: "fixtures/adt.hl7" } } as const;

const answer = (provider: string) => reply(provider, [thinking, { type: "text", text: "Reading the file." }, call]);

const lookupOf = (verdicts: ReadonlyArray<readonly [ContentKey, Seal]>): Lookup => {
	const known = new Map(verdicts);

	return (key) => known.get(key);
};

const keyOf = (message: Message) => Arr.map(partsOf(message), ({ key }) => key);

const all = (seal: Seal, messages: ReadonlyArray<Message>) =>
	Arr.flatMap(messages, (message) => Arr.map(keyOf(message), (key) => [key, seal] as const));

const guarded = (messages: ReadonlyArray<Message>, lookup: Lookup) =>
	Result.getOrThrowWith(guard({ messages, lookup }), (refusal) => new Error(refusal));

test("cleared user, tool and reply parts pass as they are", () => {
	const messages = [asked, pasted, answer("ultra-a"), read];
	const { messages: sent, report } = guarded(messages, lookupOf(all("cleared", messages)));

	expect(sent).toEqual(messages);
	expect(report).toEqual({ stubbedSealed: 0, stubbedUnknown: 0, refused: false });
});

test("a cleared reply keeps its thinking only when a personal provider wrote it", () => {
	const messages = [answer("ent"), answer("ultra-b"), answer("openai")];
	const { messages: sent } = guarded(messages, lookupOf(all("cleared", messages)));

	expect(sent).toEqual([
		reply("ent", [{ type: "text", text: "Reading the file." }, call]),
		answer("ultra-b"),
		answer("openai"),
	]);
});

test("sealed and never-judged parts become stubs that keep only roles, ids and tool names", () => {
	const messages = [asked, pasted, answer("ent"), read];
	const lookup = lookupOf([...all("sealed", [pasted, read]), ...all("cleared", [asked])]);
	const { messages: sent, report } = guarded(messages, lookup);
	const stubbedCall = { type: "toolCall", id: "toolu_7", name: "read", arguments: {} } as const;

	expect(sent).toEqual([
		asked,
		{ role: "user", content: stubs.sealed, timestamp: 2 },
		reply("ent", [{ type: "text", text: stubs.unknown }, stubbedCall]),
		{
			role: "toolResult",
			toolCallId: "toolu_7",
			toolName: "read",
			content: [{ type: "text", text: stubs.sealed }],
			isError: false,
			timestamp: 4,
		},
	]);
	expect(report).toEqual({ stubbedSealed: 2, stubbedUnknown: 1, refused: false });
});

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];

const prompt: SystemMessage = {
	role: "system",
	content: "You are a coding agent.",
	sections: { project: "Ward 4 census: Rosalind Fairweather", style: "Answer briefly." },
	toolsAdded: tools,
	timestamp: 0,
};

const promptLookup = (held: (slot: Slot) => boolean) =>
	lookupOf(Arr.flatMap(partsOf(prompt), ({ key, slot }) => (held(slot) ? [] : [[key, "cleared"] as const])));

const projectSection = (slot: Slot): boolean => Predicate.isTagged(slot, "SystemSection") && slot.name === "project";

test("an uncleared system section is stubbed while the content, other sections and tools pass", () => {
	const lookup = promptLookup(projectSection);

	expect(guarded([prompt], lookup).messages).toEqual([
		{ ...prompt, sections: { project: stubs.unknown, style: "Answer briefly." } },
	]);
});

test("tools that never cleared refuse the request", () => {
	const lookup = promptLookup(Predicate.isTagged("SystemTools"));

	expect(guard({ messages: [prompt], lookup })).toEqual(Result.fail("tools-not-cleared"));
});

const model = getBuiltinModel("anthropic", "claude-opus-5-5");

const unlinked = (): Scope => ({ kind: "protected", link: Option.none() });

const capturing = () => {
	const sent: Array<ReadonlyArray<Message>> = [];

	const api: ProviderStreams = {
		stream: (_model, context) => {
			sent.push(context.messages);

			return createAssistantMessageEventStream();
		},
		streamSimple: (_model, context) => {
			sent.push(context.messages);

			return createAssistantMessageEventStream();
		},
	};

	return { api, sent };
};

test("through the api, an open scope passes untouched and a protected one without a link stubs everything", () => {
	const plain: SystemMessage = { role: "system", content: "You are a coding agent.", timestamp: 0 };
	const context = normalizeContext({ messages: [plain, asked, read] });
	const { api, sent } = capturing();

	guardedApi({ api, account: "ultra-a", scope: () => ({ kind: "open" }) }).stream(model, context);
	guardedApi({ api, account: "ultra-a", scope: unlinked }).streamSimple(model, context);

	expect(sent).toEqual([
		context.messages,
		[
			{ ...plain, content: stubs.unknown },
			{ role: "user", content: stubs.unknown, timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "toolu_7",
				toolName: "read",
				content: [{ type: "text", text: stubs.unknown }],
				isError: false,
				timestamp: 4,
			},
		],
	]);
});

test("a refused request never reaches the account and ends in an error pi records", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { api, sent } = capturing();

			const stream = guardedApi({ api, account: "ultra-a", scope: unlinked }).stream(
				model,
				normalizeContext({ messages: [prompt, asked] }),
			);

			const result = yield* Effect.promise(() => stream.result());

			expect(sent).toEqual([]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toStartWith("phi border refused:");
		}),
	));
