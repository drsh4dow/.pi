import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";

export type Reply = Data.TaggedEnum<{
	Text: { readonly text: string };
	ToolUse: { readonly before: Option.Option<string>; readonly name: string; readonly input: Schema.JsonObject };
}>;

export const Reply = Data.taggedEnum<Reply>();

export interface Asked {
	readonly lastText: string;
	readonly body: string;
	/** The model id the request names. */
	readonly model: string;
}

type Replier = (asked: Asked) => Reply;

export interface MockAnthropic {
	/** The provider's `baseUrl`: pi-ai posts to `<url>/v1/messages?beta=true`. */
	readonly url: string;
	readonly bodies: () => ReadonlyArray<string>;
	readonly stop: Effect.Effect<void>;
}

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const Content = Schema.Union([Schema.String, Schema.Array(Schema.Json)]);

const ToolResultBlock = Schema.Struct({ type: Schema.Literal("tool_result"), content: Content });

const decodeBlock = Schema.decodeUnknownOption(Schema.Union([TextBlock, ToolResultBlock]));

const MessagesRequest = Schema.Struct({
	model: Schema.String,
	messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })),
});

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(MessagesRequest));

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const contentText = (content: typeof Content.Type): string => {
	if (Predicate.isString(content)) {
		return content;
	}

	const blocks = Arr.getSomes(Arr.map(content, (block) => decodeBlock(block)));

	return Arr.join(
		Arr.map(blocks, (block) => (block.type === "text" ? block.text : contentText(block.content))),
		"\n",
	);
};

/** A pi-ai request ends with a `system` message that carries only settings, so the last turn is the last other message. */
const lastTextOf = (request: typeof MessagesRequest.Type) =>
	Effect.fromOption(
		Option.map(
			Arr.findLast(request.messages, (message) => message.role !== "system"),
			(message) => contentText(message.content),
		),
	);

export const lastMessageText = (body: string) => Effect.flatMap(decodeRequest(body), lastTextOf);

interface Block {
	readonly start: Schema.JsonObject;
	readonly delta: Schema.JsonObject;
}

const textBlock = (text: string): Block => ({
	start: { type: "text", text: "" },
	delta: { type: "text_delta", text },
});

const toolBlock = Effect.fn("toolBlock")(function* (id: string, name: string, input: Schema.JsonObject) {
	const json = yield* encodeJson(input);

	return { start: { type: "tool_use", id, name, input: {} }, delta: { type: "input_json_delta", partial_json: json } };
});

const eventsOf = Effect.fn("eventsOf")(function* (reply: Reply, model: string, id: string) {
	const blocks: ReadonlyArray<Block> = yield* Reply.$match(reply, {
		Text: ({ text }) => Effect.succeed([textBlock(text)]),
		ToolUse: ({ before, name, input }) =>
			Effect.map(toolBlock(`toolu_${id}`, name, input), (tool) => [
				...Option.toArray(Option.map(before, textBlock)),
				tool,
			]),
	});

	const stopReason = Reply.$is("Text")(reply) ? "end_turn" : "tool_use";

	const message = {
		id: `msg_${id}`,
		type: "message",
		role: "assistant",
		model,
		content: [],
		usage: { input_tokens: 1, output_tokens: 0 },
	};

	const events: ReadonlyArray<Schema.JsonObject & { readonly type: string }> = [
		{ type: "message_start", message },
		...Arr.flatMap(blocks, (block, index) => [
			{ type: "content_block_start", index, content_block: block.start },
			{ type: "content_block_delta", index, delta: block.delta },
			{ type: "content_block_stop", index },
		]),
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];

	return events;
});

const sseOf = Effect.fn("sseOf")(function* (reply: Reply, model: string, id: string) {
	const events = yield* eventsOf(reply, model, id);

	const frames = yield* Effect.forEach(events, (event) =>
		Effect.map(encodeJson(event), (json) => `event: ${event.type}\ndata: ${json}\n\n`),
	);

	return Arr.join(frames, "");
});

const badRequest = (error: { readonly message: string }) =>
	Effect.succeed(new Response(error.message, { status: 400 }));

const respond = (reply: Replier, bodies: Array<string>) =>
	Effect.fn("respond")(
		function* (request: Request) {
			const body = yield* Effect.promise(() => request.text());

			bodies.push(body);

			if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") {
				return new Response("not found", { status: 404 });
			}

			const messages = yield* decodeRequest(body);
			const lastText = yield* lastTextOf(messages);
			const next = reply({ lastText, body, model: messages.model });
			const sse = yield* sseOf(next, messages.model, `mock_${String(bodies.length)}`);

			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		},
		Effect.catchTags({ SchemaError: badRequest, NoSuchElementError: badRequest }),
	);

export const serveMock = (reply: Replier): MockAnthropic => {
	const bodies: Array<string> = [];
	const handle = respond(reply, bodies);

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => Effect.runPromise(handle(request)),
	});

	server.unref();

	return {
		url: `http://127.0.0.1:${String(server.port)}`,
		bodies: () => Arr.copy(bodies),
		stop: Effect.promise(() => server.stop(true)),
	};
};

/** A phrase from the harness compaction's system prompt, so a mock can tell a summary request apart. */
export const compactionPrompt = "the narrative part of a coding agent";

/** The `models` entries that point each provider at its mock. */
export const mockedModels = <Provider extends string>(mocks: Readonly<Record<Provider, Pick<MockAnthropic, "url">>>) =>
	Rec.map(mocks, ({ url }) => ({ baseUrl: url }));
