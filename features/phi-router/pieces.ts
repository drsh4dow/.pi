/**
 * From pi-ai messages to the engine's pieces: each part with its kind and the context the judge reads beside it.
 */
import type { AssistantMessage, Message, SystemMessage } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { blocksOf, textsOf, unitsOf, writtenOnPersonal } from "./parts.ts";
import type { ContentKey, Piece, PieceKind } from "./policy/engine.ts";
import { window as policyWindow, seamChars, stubs } from "./policy/policy.ts";

const kinds = { system: "system", user: "user", toolResult: "tool-result" } as const;

const kindOf = (message: Message, producedOnPersonal: (message: AssistantMessage) => boolean): PieceKind => {
	if (message.role !== "assistant") {
		return kinds[message.role];
	}

	return producedOnPersonal(message) ? "reply-personal" : "reply-other";
};

const labels = { user: "user", assistant: "assistant", toolResult: "tool result" } as const;

const textOf = (message: Exclude<Message, SystemMessage>) => Arr.join(textsOf(blocksOf(message.content)), "\n");

/** How a message reads as context: its role, then its texts. */
const itemOf = (message: Exclude<Message, SystemMessage>) => `[${labels[message.role]}] ${textOf(message)}`;

const callsOf = (message: AssistantMessage) =>
	Arr.flatMap(message.content, (block) =>
		block.type === "toolCall" ? [[block.id, `[tool call] ${Arr.join(textsOf([block]), "")}`] as const] : [],
	);

const endsMidWord = /[\p{L}\p{N}]$/u;

const startsAtOnce = /^\S/u;

/**
 * Remembers the items and tool calls read so far, a sealed one as its stub, and gives the next message its context. A
 * user message or tool result that starts right where the previous one of its role stopped mid-word, as an output cut
 * at a limit and fetched again does, gets that one's end as its seam, so an identifier cut in two is judged whole.
 */
const contextReader = (window: number) => {
	const calls = new Map<string, string>();
	const items: Array<string> = [];
	const lastText = new Map<Message["role"], string>();

	const seamOf = (message: Message) => {
		const text = message.role === "system" ? "" : textOf(message);
		const previous = lastText.get(message.role) ?? "";
		const continues = endsMidWord.test(previous) && startsAtOnce.test(text);

		return continues ? Str.takeRight(previous, seamChars) : "";
	};

	const contextOf = (message: Message): ReadonlyArray<string> => {
		if (message.role === "system") {
			return [];
		}

		const ownCall =
			message.role === "toolResult" ? Option.fromUndefinedOr(calls.get(message.toolCallId)) : Option.none();

		return Arr.take([...Option.toArray(ownCall), ...Arr.reverse(Arr.takeRight(items, window))], window);
	};

	const remember = ({ message, sealed }: { readonly message: Message; readonly sealed: boolean }) => {
		if (message.role === "system") {
			return;
		}

		lastText.set(message.role, sealed ? "" : textOf(message));

		items.push(sealed ? `[${labels[message.role]}] ${stubs.sealed}` : itemOf(message));

		for (const [id, call] of message.role === "assistant" ? callsOf(message) : []) {
			calls.set(id, sealed ? `[tool call] ${stubs.sealed}` : call);
		}
	};

	return { contextOf, seamOf, remember };
};

interface PieceAt {
	readonly piece: Piece;
	/** In the request's own new content: the last assistant message and everything after it. */
	readonly own: boolean;
}

/**
 * Every part of a request as a piece to judge, with at most `window` preceding items as context, nearest first. A tool
 * result's first item is its own tool call. `producedOnPersonal` tells `reply-personal` from `reply-other`. A message
 * `sealed` names reaches later context only as the stub.
 */
export const piecesOf = ({
	messages,
	producedOnPersonal = writtenOnPersonal,
	window = policyWindow,
	sealed = () => false,
}: {
	readonly messages: ReadonlyArray<Message>;
	readonly producedOnPersonal?: (message: AssistantMessage) => boolean;
	readonly window?: number;
	readonly sealed?: (key: ContentKey) => boolean;
}): ReadonlyArray<PieceAt> => {
	const ownFrom = Option.getOrElse(
		Arr.findLastIndex(messages, ({ role }) => role === "assistant"),
		() => 0,
	);

	const reader = contextReader(window);
	const pieces: Array<PieceAt> = [];

	for (const [index, message] of messages.entries()) {
		const piece = {
			kind: kindOf(message, producedOnPersonal),
			context: reader.contextOf(message),
			seam: reader.seamOf(message),
		};

		const units = unitsOf(message);

		for (const { key, texts, images } of units) {
			pieces.push({ piece: { ...piece, key, texts, images }, own: index >= ownFrom });
		}

		reader.remember({ message, sealed: Arr.some(units, ({ key }) => sealed(key)) });
	}

	return pieces;
};
