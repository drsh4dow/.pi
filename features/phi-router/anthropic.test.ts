import { expect, test } from "bun:test";

import type { AssistantMessage, Context, Message, ToolCall } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Type } from "typebox";

import { lastMessageText, type MockAnthropic, Reply, serveMock } from "./anthropic.fixture.ts";

const lookup = { query: "weather in Lisbon", limit: 3 };

const reply = ({ lastText }: { readonly lastText: string }) =>
	lastText === "use the tool"
		? Reply.ToolUse({ before: Option.some("Looking it up."), name: "lookup", input: lookup })
		: Reply.Text({ text: `you said: ${lastText}` });

const tools = [
	{
		name: "lookup",
		description: "Looks a query up.",
		parameters: Type.Object({ query: Type.String(), limit: Type.Number() }),
	},
];

const withMock = <Value, Failure>(use: (mock: MockAnthropic) => Effect.Effect<Value, Failure>) =>
	Effect.runPromise(
		Effect.acquireUseRelease(
			Effect.sync(() => serveMock(reply)),
			use,
			(mock) => mock.stop,
		),
	);

const ask = (mock: MockAnthropic, messages: Array<Message>) => {
	const model = { ...getBuiltinModel("anthropic", "claude-opus-5-5"), baseUrl: mock.url };
	const context: Context = { messages, tools };

	return Effect.promise(() => complete(model, context, { apiKey: "test-key" }));
};

const userSays = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

const toolCallOf = (message: AssistantMessage) =>
	Arr.findFirst(message.content, (block): block is ToolCall => block.type === "toolCall");

test("a text reply arrives as the assistant's text, built from the last message's text", () =>
	withMock((mock) =>
		Effect.map(ask(mock, [userSays("hello there")]), (answer) => {
			expect([answer.stopReason, answer.content]).toEqual([
				"stop",
				[{ type: "text", text: "you said: hello there" }],
			]);
		}),
	));

test("a tool reply arrives as its text, then a tool call with the reply's name and input, and stops for tool use", () =>
	withMock((mock) =>
		Effect.map(ask(mock, [userSays("use the tool")]), (answer) => {
			const shown = Arr.map(answer.content, (block) =>
				block.type === "toolCall" ? { name: block.name, arguments: block.arguments } : block,
			);

			expect([answer.stopReason, shown]).toEqual([
				"toolUse",
				[
					{ type: "text", text: "Looking it up." },
					{ name: "lookup", arguments: lookup },
				],
			]);
		}),
	));

test("the mock records each request body, and the last message's text is the user's, then the tool result's", () =>
	withMock((mock) =>
		Effect.gen(function* () {
			const asked = userSays("use the tool");
			const called = yield* ask(mock, [asked]);
			const toolCall = yield* Effect.fromOption(toolCallOf(called));

			yield* ask(mock, [
				asked,
				called,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: "sunny, 21 C" }],
					isError: false,
					timestamp: 0,
				},
			]);

			const lastTexts = yield* Effect.forEach(mock.bodies(), lastMessageText);

			expect(lastTexts).toEqual(["use the tool", "sunny, 21 C"]);
		}),
	));
