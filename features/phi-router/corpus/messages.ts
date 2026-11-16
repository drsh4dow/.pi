/**
 * From a manifest case to the pi-ai messages of each request pi sends for it. Only this module and `requests.ts` know
 * the manifest's turns.
 */
import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type Case, type Part, type Transcript, transcriptOf } from "./manifest.ts";
import { requestsOf } from "./requests.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** `requests.ts` writes a tool call as `<name> <id> <json input>`. */
const callPattern = /^(?<name>\S+) (?<id>toolu_mock_\d+) (?<input>\{[\s\S]*\})$/u;

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)));

const callOf = (text: string): Option.Option<ToolCall> => {
	const groups = callPattern.exec(text)?.groups;

	if (groups?.["name"] === undefined || groups["id"] === undefined) {
		return Option.none();
	}

	const { name, id } = groups;

	return Option.map(decodeInput(groups["input"]), (input) => ({ type: "toolCall", id, name, arguments: input }));
};

const blockOf = (part: Part): TextContent | ImageContent =>
	part.kind === "text"
		? { type: "text", text: part.text }
		: { type: "image", mimeType: part.mimeType, data: part.data };

const textOf = (parts: ReadonlyArray<Part>) =>
	Arr.join(
		Arr.flatMap(parts, (part) => (part.kind === "text" ? [part.text] : [])),
		"\n",
	);

/** A corpus reply counts as written on `ent`, so the router judges it. */
const replyOf = (parts: ReadonlyArray<Part>): AssistantMessage => ({
	role: "assistant",
	content: Arr.map(parts, (part) => {
		const text = textOf([part]);

		return Option.getOrElse(callOf(text), (): TextContent => ({ type: "text", text }));
	}),
	api: "anthropic-messages",
	provider: "ent",
	model: "claude-opus-5-5",
	usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
	stopReason: "stop",
	timestamp: 0,
});

/** A tool turn's first part is its call's id; `names` holds the request's calls by id. */
const toolResultOf = (parts: ReadonlyArray<Part>, names: ReadonlyMap<string, string>): ToolResultMessage => {
	const [head, ...output] = parts;
	const toolCallId = head?.kind === "text" ? head.text : "";

	return {
		role: "toolResult",
		toolCallId,
		toolName: names.get(toolCallId) ?? "",
		content: Arr.map(output, blockOf),
		isError: false,
		timestamp: 0,
	};
};

const messageOf = ({ role, parts }: Transcript[number], names: ReadonlyMap<string, string>): Message => {
	switch (role) {
		case "system": {
			return { role, content: textOf(parts), timestamp: 0 };
		}

		case "user": {
			return { role, content: Arr.map(parts, blockOf), timestamp: 0 };
		}

		case "assistant": {
			return replyOf(parts);
		}

		case "tool": {
			return toolResultOf(parts, names);
		}

		default: {
			const unhandled: never = role;

			return unhandled;
		}
	}
};

/** The pi-ai messages of one request, as pi sends them. */
const messagesOf = (request: Transcript): Array<Message> => {
	const calls = Arr.flatMap(request, ({ role, parts }) =>
		role === "assistant" ? Arr.getSomes(Arr.map(parts, (part) => callOf(textOf([part])))) : [],
	);

	const names = new Map(Arr.map(calls, ({ id, name }) => [id, name] as const));

	return Arr.map(request, (turn) => messageOf(turn, names));
};

/** Every request the case makes, with the case's system messages first, as pi reads them from `AGENTS.md`. */
export const requestMessagesOf = Effect.fn("requestMessagesOf")(function* (subject: Case) {
	const system = transcriptOf(Arr.filter(subject.messages, ({ role }) => role === "system"));
	const requests = yield* Effect.orDie(requestsOf(subject));

	return Arr.map(requests, (request) => messagesOf([...system, ...request]));
});
