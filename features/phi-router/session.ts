import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { type SessionEntry, VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";

import type { Part, Transcript, Turn } from "./policy/index.ts";
import { RouterState, type Stored } from "./route.ts";

export const phiProvider = "phi";

export const phiId = "auto";

const text = (value: string): Part => ({ kind: "text", text: value });

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type Block = Exclude<Message["content"], string>[number];

/** Redacted thinking is skipped: it is the model's own output, opaque, and derived from content already routed. */
const partsOf = (block: Block): Effect.Effect<ReadonlyArray<Part>, Schema.SchemaError> => {
	switch (block.type) {
		case "text": {
			return Effect.succeed([text(block.text)]);
		}

		case "image": {
			return Effect.succeed([{ kind: "image", mimeType: block.mimeType, data: block.data }]);
		}

		case "thinking": {
			return Effect.succeed(block.redacted === true ? [] : [text(block.thinking)]);
		}

		case "toolCall": {
			return Effect.map(jsonOf(block.arguments), (json) => [text(`${block.name} ${block.id} ${json}`)]);
		}

		default: {
			const unhandled: never = block;

			return unhandled;
		}
	}
};

const contentParts = (content: Message["content"]) =>
	Predicate.isString(content)
		? Effect.succeed([text(content)])
		: Effect.map(Effect.forEach(content, partsOf), Arr.flatten);

const sectionParts = (sections: SystemMessage["sections"]) =>
	Arr.flatMap(Rec.toEntries(sections ?? {}), ([name, section]) => [
		text(name),
		...(section === null ? [] : [text(section)]),
	]);

const toolParts = ({ toolsAdded = [], toolsRemoved = [] }: SystemMessage) =>
	Effect.map(
		Effect.forEach(toolsAdded, ({ name, description, parameters }) =>
			Effect.map(jsonOf(parameters), (schema) => text(`${name} ${description} ${schema}`)),
		),
		(added) => [...added, ...Arr.map(toolsRemoved, ({ name }) => text(name))],
	);

const systemTurn = (message: SystemMessage) =>
	Effect.zipWith(contentParts(message.content), toolParts(message), (parts, tools): Turn => ({
		role: "system",
		parts: [...parts, ...sectionParts(message.sections), ...tools],
	}));

const turnOf = (message: Message): Effect.Effect<Turn, Schema.SchemaError> => {
	if (message.role === "system") {
		return systemTurn(message);
	}

	const parts = contentParts(message.content);

	return Effect.map(parts, (found): Turn => ({
		role: message.role === "toolResult" ? "tool" : message.role,
		parts: message.role === "toolResult" ? [text(message.toolCallId), ...found] : found,
	}));
};

/**
 * Everything a request carries, system turns and the named sections pi puts project context in included, in the
 * engine's shape.
 */
export const transcriptOf = (messages: ReadonlyArray<Message>): Effect.Effect<Transcript, Schema.SchemaError> =>
	Effect.forEach(messages, turnOf);

const PhiStateOwner = Schema.Struct({ provider: Schema.Literal(phiProvider), modelId: Schema.Literal(phiId) });

const isPhiStateEntry = Schema.is(
	Schema.Struct({
		type: Schema.Literal("custom"),
		customType: Schema.Literal(VIRTUAL_MODEL_STATE_ENTRY),
		data: PhiStateOwner,
	}),
);

const decodeStateEntry = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Struct({ state: RouterState }) }));

const storedIn = (entry: SessionEntry) =>
	Option.match(decodeStateEntry(entry), {
		onNone: (): Stored => ({ kind: "malformed" }),
		onSome: ({ data }): Stored => ({ kind: "found", state: data.state }),
	});

/** The router state the branch's next `phi/auto` request would get, read as pi reads it: the latest on the branch. */
export const storedOnBranch = (branch: ReadonlyArray<SessionEntry>): Stored =>
	Option.match(Arr.findLast(branch, isPhiStateEntry), {
		onNone: (): Stored => ({ kind: "missing" }),
		onSome: storedIn,
	});
