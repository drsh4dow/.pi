/**
 * From pi-ai messages to the engine's pieces. The one key function lives here, so `route()` and the lane border key every
 * part alike, except where pi itself changes a message between them.
 */
import type {
	AssistantMessage,
	ImageContent,
	Message,
	SystemMessage,
	TextContent,
	Tool,
	ThinkingContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";

import { accountOf } from "../claude-accounts/index.ts";
import { sha256 } from "./policy/digest.ts";
import { ContentKey, type Image, type Piece, type PieceKind } from "./policy/engine.ts";
import { window as policyWindow, stubs } from "./policy/policy.ts";

const MessageSlot = Schema.TaggedStruct("Message", {});

const SystemContent = Schema.TaggedStruct("SystemContent", {});

const SystemSection = Schema.TaggedStruct("SystemSection", { name: Schema.String });

/** Tool declarations. Stubbing one would break tool pairing, so an uncleared one refuses the request. */
const SystemTools = Schema.TaggedStruct("SystemTools", {});

/** Where a part sits in its message, and so how the border stubs it. */
export const Slot = Schema.Union([MessageSlot, SystemContent, SystemSection, SystemTools]);

export type Slot = typeof Slot.Type;

export interface Part {
	readonly key: ContentKey;
	readonly slot: Slot;
}

const field = (value: string) => `${String(value.length)}:${value}`;

/** SHA-256 over length-prefixed fields, the first naming the role or system slot. */
export const contentKey = (fields: ReadonlyArray<string>) => {
	const encoded = Arr.join(Arr.map(fields, field), "");

	return ContentKey.make(sha256(encoded));
};

const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Tool arguments and schemas are parsed JSON, so encoding them cannot fail. */
const jsonOf = (value: ToolCall["arguments"] | Tool["parameters"]) => Option.getOrThrow(encodeJson(value));

type Block = TextContent | ImageContent | ThinkingContent | ToolCall;

const blocksOf = (content: string | ReadonlyArray<Block>): ReadonlyArray<Block> =>
	Predicate.isString(content) ? [{ type: "text", text: content }] : content;

/** Thinking is left out: the border strips it from replies a personal account did not write. */
const fieldsOf = (block: Block): ReadonlyArray<string> => {
	switch (block.type) {
		case "text": {
			return ["text", block.text];
		}

		case "image": {
			return ["image", block.mimeType, block.data];
		}

		case "thinking": {
			return [];
		}

		case "toolCall": {
			return ["call", block.id, block.name, jsonOf(block.arguments)];
		}

		default: {
			const unhandled: never = block;

			return unhandled;
		}
	}
};

const textsOf = (blocks: ReadonlyArray<Block>) =>
	Arr.flatMap(blocks, (block) => {
		if (block.type === "text") {
			return [block.text];
		}

		return block.type === "toolCall" ? [`${block.name}(${jsonOf(block.arguments)})`] : [];
	});

const imagesOf = (blocks: ReadonlyArray<Block>): ReadonlyArray<Image> =>
	Arr.flatMap(blocks, (block) => (block.type === "image" ? [{ mimeType: block.mimeType, data: block.data }] : []));

/** A part with what the judge reads of it. */
interface Unit extends Part {
	readonly texts: ReadonlyArray<string>;
	readonly images: ReadonlyArray<Image>;
}

const unitOf = ({
	fields,
	blocks,
	slot,
}: {
	fields: ReadonlyArray<string>;
	blocks: ReadonlyArray<Block>;
	slot: Slot;
}) => ({
	key: contentKey([...fields, ...Arr.flatMap(blocks, fieldsOf)]),
	slot,
	texts: textsOf(blocks),
	images: imagesOf(blocks),
});

const toolsUnit = ({ toolsAdded = [], toolsRemoved = [] }: SystemMessage): ReadonlyArray<Unit> => {
	if (toolsAdded.length === 0 && toolsRemoved.length === 0) {
		return [];
	}

	const added = Arr.map(toolsAdded, ({ name, description, parameters }) => [name, description, jsonOf(parameters)]);
	const removed = Arr.map(toolsRemoved, ({ name }) => name);

	return [
		{
			key: contentKey(["system-tools", ...Arr.flatMap(added, (tool) => ["add", ...tool]), ...removed]),
			slot: SystemTools.make({}),
			texts: [...Arr.map(added, Arr.join("\n")), ...Arr.map(removed, (name) => `removed tool ${name}`)],
			images: [],
		},
	];
};

/** A content part, one part per section still present, and one tools part when tools change. */
const systemUnits = (message: SystemMessage): ReadonlyArray<Unit> => {
	const content = unitOf({
		fields: ["system-content"],
		blocks: blocksOf(message.content),
		slot: SystemContent.make({}),
	});

	const sections = Arr.flatMap(Rec.toEntries(message.sections ?? {}), ([name, section]) =>
		section === null
			? []
			: [
					unitOf({
						fields: ["system-section", name],
						blocks: blocksOf(section),
						slot: SystemSection.make({ name }),
					}),
				],
	);

	return [content, ...sections, ...toolsUnit(message)];
};

const unitsOf = (message: Message): ReadonlyArray<Unit> => {
	switch (message.role) {
		case "system": {
			return systemUnits(message);
		}

		case "user": {
			return [unitOf({ fields: ["user"], blocks: blocksOf(message.content), slot: MessageSlot.make({}) })];
		}

		case "toolResult": {
			const fields = ["tool", "isError", String(message.isError)];

			return [unitOf({ fields, blocks: message.content, slot: MessageSlot.make({}) })];
		}

		case "assistant": {
			return [unitOf({ fields: ["assistant"], blocks: message.content, slot: MessageSlot.make({}) })];
		}

		default: {
			const unhandled: never = message;

			return unhandled;
		}
	}
};

/**
 * The stub-able parts of one message and their keys. Keys leave out `toolCallId`, timestamps, the provider, model and
 * usage, and thinking, so a retry, a resend after compaction and a repeated file read share a key.
 */
export const partsOf = (message: Message): ReadonlyArray<Part> =>
	Arr.map(unitsOf(message), ({ key, slot }) => ({ key, slot }));

/** Whether a personal Claude account wrote this reply, read from its provider. */
export const writtenOnPersonal = (message: AssistantMessage) =>
	Option.exists(accountOf(message.provider), ({ baa }) => !baa);

const kinds = { system: "system", user: "user", toolResult: "tool-result" } as const;

const kindOf = (message: Message, producedOnPersonal: (message: AssistantMessage) => boolean): PieceKind => {
	if (message.role !== "assistant") {
		return kinds[message.role];
	}

	return producedOnPersonal(message) ? "reply-personal" : "reply-other";
};

const labels = { user: "user", assistant: "assistant", toolResult: "tool result" } as const;

/** How a message reads as context: its role, then its texts. */
const itemOf = (message: Exclude<Message, SystemMessage>) =>
	`[${labels[message.role]}] ${Arr.join(textsOf(blocksOf(message.content)), "\n")}`;

const callsOf = (message: AssistantMessage) =>
	Arr.flatMap(message.content, (block) =>
		block.type === "toolCall" ? [[block.id, `[tool call] ${Arr.join(textsOf([block]), "")}`] as const] : [],
	);

/** Remembers the items and tool calls read so far, a sealed one as its stub, and gives the next message its context. */
const contextReader = (window: number) => {
	const calls = new Map<string, string>();
	const items: Array<string> = [];

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

		items.push(sealed ? `[${labels[message.role]}] ${stubs.sealed}` : itemOf(message));

		for (const [id, call] of message.role === "assistant" ? callsOf(message) : []) {
			calls.set(id, sealed ? `[tool call] ${stubs.sealed}` : call);
		}
	};

	return { contextOf, remember };
};

export interface PieceAt {
	readonly piece: Piece;
	readonly message: number;
	readonly slot: Slot;
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
		const piece = { kind: kindOf(message, producedOnPersonal), context: reader.contextOf(message) };
		const units = unitsOf(message);

		for (const { key, slot, texts, images } of units) {
			pieces.push({ piece: { ...piece, key, texts, images }, message: index, slot, own: index >= ownFrom });
		}

		reader.remember({ message, sealed: Arr.some(units, ({ key }) => sealed(key)) });
	}

	return pieces;
};
