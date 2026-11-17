import { expect, test } from "bun:test";

import type { AssistantMessage, Context, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import { classify } from "@earendil-works/pi-ai/api/openai-decisions";
import { complete } from "@earendil-works/pi-ai/compat";
import { getBuiltinClassifierModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { Type } from "typebox";

import { Reply } from "./anthropic.fixture.ts";
import { decisionsPieceJudge } from "./decisions.ts";
import { type MockOpenAi, serveOpenAi } from "./openai.fixture.ts";
import { judgeModel } from "./policy/policy.ts";

const lookup = { query: "weather in Lisbon", limit: 3 };

const reply = ({ lastText, model }: { readonly lastText: string; readonly model: string }) =>
	lastText === "use the tool"
		? Reply.ToolUse({ before: Option.none(), name: "lookup", input: lookup })
		: Reply.Text({ text: `${model} heard: ${lastText}` });

const tools = [
	{
		name: "lookup",
		description: "Looks a query up.",
		parameters: Type.Object({ query: Type.String(), limit: Type.Number() }),
	},
];

const judgeInput = (piece: string) => ({ piece, context: [], images: [] });

const withMock = <Value, Failure>(use: (mock: MockOpenAi) => Effect.Effect<Value, Failure>) =>
	Effect.runPromise(
		Effect.acquireUseRelease(
			Effect.sync(() => serveOpenAi({ reply, sealed: Str.includes("MRN") })),
			use,
			(mock) => mock.stop,
		),
	);

const chatModel = (provider: "openai" | "opencode-go", api: string) =>
	Effect.fromOption(Arr.findFirst(getBuiltinModels(provider), (model) => model.api === api));

const ask = (model: Model<string>, mock: MockOpenAi, messages: Array<Message>) => {
	const context: Context = { messages, tools };

	return Effect.promise(() => complete({ ...model, baseUrl: mock.url }, context, { apiKey: "test-key" }));
};

const userSays = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

const toolCallOf = (message: AssistantMessage) =>
	Arr.findFirst(message.content, (block): block is ToolCall => block.type === "toolCall");

const toolRound = (model: Model<string>, mock: MockOpenAi) =>
	Effect.gen(function* () {
		const asked = userSays("use the tool");
		const called = yield* ask(model, mock, [asked]);
		const toolCall = yield* Effect.fromOption(toolCallOf(called));

		const answered = yield* ask(model, mock, [
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

		return { called, answered };
	});

test.each([
	["openai", "openai-responses"],
	["opencode-go", "openai-completions"],
] as const)(
	"on %s's %s a tool call arrives with the reply's input, and the tool result is the next turn",
	(provider, api) =>
		withMock((mock) =>
			Effect.gen(function* () {
				const model = yield* chatModel(provider, api);
				const { called, answered } = yield* toolRound(model, mock);

				expect([called.stopReason, called.content]).toEqual([
					"toolUse",
					[expect.objectContaining({ type: "toolCall", name: "lookup", arguments: lookup })],
				]);
				expect([answered.stopReason, answered.content]).toEqual([
					"stop",
					[expect.objectContaining({ type: "text", text: `${model.id} heard: sunny, 21 C` })],
				]);
				expect(mock.bodies()).toHaveLength(2);
			}),
		),
);

test("the Decisions route seals exactly the pieces `sealed` holds for, and labels them with a kind", () =>
	withMock((mock) =>
		Effect.gen(function* () {
			const model = { ...getBuiltinClassifierModel("openai", judgeModel), baseUrl: mock.url };
			const judge = decisionsPieceJudge((context, options) => classify(model, context, { ...options, apiKey: "k" }));

			const clean = yield* judge.identifier(judgeInput("The build uses bun."));
			const sealed = yield* judge.identifier(judgeInput("PID|1||MRN88310427"));
			const kind = yield* judge.kind(judgeInput("PID|1||MRN88310427"));

			expect([clean.score, sealed.score, kind.kind]).toEqual([0, 1, "mrn"]);
			expect(mock.decisions()).toHaveLength(3);
			expect(mock.bodies()).toHaveLength(0);
		}),
	));
