import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { type Asked, Reply } from "./anthropic.fixture.ts";
import type { IdentifierKind } from "./policy/policy.ts";

export interface MockOpenAi {
	/**
	 * The provider's `baseUrl`, ending in `/v1`: pi-ai posts chat to `<url>/responses` (openai-responses) or
	 * `<url>/chat/completions` (openai-completions), and the Decisions classifier to `<url>/decisions`.
	 */
	readonly url: string;
	/** Every request body but the Decisions ones, oldest first. */
	readonly bodies: () => ReadonlyArray<string>;
	/** Every Decisions request body, oldest first. */
	readonly decisions: () => ReadonlyArray<string>;
	readonly stop: Effect.Effect<void>;
}

const Content = Schema.Union([Schema.String, Schema.Array(Schema.Json)]);

const decodeTextBlock = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }));

const contentText = (content: typeof Content.Type) =>
	Predicate.isString(content)
		? content
		: Arr.join(
				Arr.getSomes(Arr.map(content, (block) => Option.map(decodeTextBlock(block), ({ text }) => text))),
				"\n",
			);

/** A turn of the conversation: a user message, a Chat Completions tool message, or a Responses tool output. */
const Turn = Schema.Union([
	Schema.Struct({ role: Schema.Literals(["user", "tool"]), content: Content }),
	Schema.Struct({ type: Schema.Literal("function_call_output"), output: Content }),
]);

const decodeTurn = Schema.decodeUnknownOption(Turn);

const turnText = (item: Schema.Json) =>
	Option.map(decodeTurn(item), (turn) => contentText("output" in turn ? turn.output : turn.content));

/** A request from pi-ai may end with a system, developer or configuration item, so the last turn is the last user or tool one. */
const lastTurnText = (items: ReadonlyArray<Schema.Json>) => {
	const turns = Arr.getSomes(Arr.map(items, turnText));

	return Effect.fromOption(Arr.last(turns));
};

const ChatRequest = Schema.Union([
	Schema.Struct({ model: Schema.String, input: Schema.Array(Schema.Json) }),
	Schema.Struct({ model: Schema.String, messages: Schema.Array(Schema.Json) }),
]);

const decodeChat = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatRequest));

const Question = Schema.Struct({ type: Schema.Literals(["predicate", "choice"]), name: Schema.String });

const DecisionsRequest = Schema.Struct({
	input: Schema.fromJsonString(Schema.Struct({ piece: Schema.String })),
	questions: Schema.Array(Question),
});

const decodeDecisions = Schema.decodeUnknownEffect(Schema.fromJsonString(DecisionsRequest));

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const sseOf = (frames: ReadonlyArray<Schema.JsonObject & { readonly type?: string }>) =>
	Effect.map(
		Effect.forEach(frames, (frame) => encodeJson(frame)),
		(lines) =>
			Arr.join(
				Arr.map(lines, (json) => `data: ${json}\n\n`),
				"",
			),
	);

const argumentsOf = (reply: Reply) =>
	Reply.$match(reply, {
		Text: () => Effect.succeed(""),
		ToolUse: ({ input }) => encodeJson(input),
	});

/** Responses streams each output item whole, so `output_item.added` and `.done` carry the same item. */
const responsesFrames = Effect.fn("responsesFrames")(function* (reply: Reply, id: string) {
	const args = yield* argumentsOf(reply);

	const message = (text: string) => ({
		type: "message",
		id: `msg_${id}`,
		role: "assistant",
		content: [{ type: "output_text", text }],
	});

	const items: ReadonlyArray<Schema.JsonObject> = Reply.$match(reply, {
		Text: ({ text }) => [message(text)],
		ToolUse: ({ before, name }) => [
			...Option.toArray(Option.map(before, message)),
			{ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: args },
		],
	});

	const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

	return yield* sseOf([
		{ type: "response.created", response: { id: `resp_${id}` } },
		...Arr.flatMap(items, (item, index) => [
			{ type: "response.output_item.added", output_index: index, item },
			{ type: "response.output_item.done", output_index: index, item },
		]),
		{ type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: items, usage } },
	]);
});

const completionsFrames = Effect.fn("completionsFrames")(function* (reply: Reply, model: string, id: string) {
	const args = yield* argumentsOf(reply);
	const head = { id: `chatcmpl_${id}`, object: "chat.completion.chunk", model };

	const deltas: ReadonlyArray<Schema.JsonObject> = Reply.$match(reply, {
		Text: ({ text }) => [{ role: "assistant", content: text }],
		ToolUse: ({ before, name }) => [
			...Option.toArray(Option.map(before, (text) => ({ role: "assistant", content: text }))),
			{ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name, arguments: args } }] },
		],
	});

	const finish = Reply.$is("Text")(reply) ? "stop" : "tool_calls";
	const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

	const frames = yield* sseOf([
		...Arr.map(deltas, (delta) => ({ ...head, choices: [{ index: 0, delta }] })),
		{ ...head, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
	]);

	return `${frames}data: [DONE]\n\n`;
});

/** A piece the caller seals is labelled with this kind: any kind but `none` seals. */
const sealedKind: IdentifierKind = "mrn";

const decisionsAnswer = Effect.fn("decisionsAnswer")(function* (body: string, sealed: (piece: string) => boolean) {
	const { input, questions } = yield* decodeDecisions(body);
	const isSealed = sealed(input.piece);
	const choice = isSealed ? sealedKind : "none";

	const answers = Arr.map(questions, ({ type, name }) =>
		type === "predicate"
			? { name, type, probability: isSealed ? 1 : 0 }
			: { name, type, choice, probabilities: [{ value: choice, probability: 1 }], confidence: 1 },
	);

	return yield* encodeJson({ answers, usage: { input_tokens: 1, output_tokens: 1 } });
});

const chatAnswer = Effect.fn("chatAnswer")(function* (body: string, reply: (asked: Asked) => Reply, id: string) {
	const request = yield* decodeChat(body);
	const isResponses = "input" in request;
	const lastText = yield* lastTurnText(isResponses ? request.input : request.messages);
	const next = reply({ lastText, body, model: request.model });

	return isResponses ? yield* responsesFrames(next, id) : yield* completionsFrames(next, request.model, id);
});

interface Script {
	readonly reply: (asked: Asked) => Reply;
	readonly sealed: (piece: string) => boolean;
}

const decided = (body: string, sealed: Script["sealed"]) =>
	Effect.map(
		decisionsAnswer(body, sealed),
		(json) => new Response(json, { headers: { "content-type": "application/json" } }),
	);

const badRequest = (error: { readonly message: string }) =>
	Effect.succeed(new Response(error.message, { status: 400 }));

const chatPaths = new Set(["/v1/responses", "/v1/chat/completions"]);

const respond = ({
	script,
	bodies,
	decisions,
}: {
	readonly script: Script;
	readonly bodies: Array<string>;
	readonly decisions: Array<string>;
}) =>
	Effect.fn("respond")(
		function* (request: Request) {
			const body = yield* Effect.promise(() => request.text());
			const path = new URL(request.url).pathname;

			if (request.method === "POST" && path === "/v1/decisions") {
				decisions.push(body);

				return yield* decided(body, script.sealed);
			}

			bodies.push(body);

			if (request.method !== "POST" || !chatPaths.has(path)) {
				return new Response("not found", { status: 404 });
			}

			const sse = yield* chatAnswer(body, script.reply, `mock_${String(bodies.length)}`);

			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		},
		Effect.catchTags({ SchemaError: badRequest, NoSuchElementError: badRequest }),
	);

/**
 * A mock of the OpenAI-shaped routes pi-ai uses: Responses and Chat Completions chat, scripted by `reply` as the
 * Anthropic mock is, and the Decisions classifier, which answers that a piece holds an identifier exactly when `sealed`
 * holds for it.
 */
export const serveOpenAi = (script: Script): MockOpenAi => {
	const bodies: Array<string> = [];
	const decisions: Array<string> = [];
	const handle = respond({ script, bodies, decisions });

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => Effect.runPromise(handle(request)),
	});

	server.unref();

	return {
		url: `http://127.0.0.1:${String(server.port)}/v1`,
		bodies: () => Arr.copy(bodies),
		decisions: () => Arr.copy(decisions),
		stop: Effect.promise(() => server.stop(true)),
	};
};
