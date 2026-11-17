import { expect, test } from "bun:test";

import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { partsOf } from "./parts.ts";
import { piecesOf } from "./pieces.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const reply = (provider: string, content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider,
	model: "claude-opus-5-5",
	usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
	stopReason: "toolUse",
	timestamp: 1,
});

const readCall = {
	type: "toolCall",
	id: "toolu_1",
	name: "read",
	arguments: { path: "notes/admissions.csv" },
} as const;

const result = (text: string, toolCallId = "toolu_1"): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 2,
});

const asked = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

const keyOf = (message: Message) => Arr.map(partsOf(message), ({ key }) => key);

test("a tool result read again under a new tool call id and time keeps its key, and new text changes it", () => {
	const first = result("id,name\n4471,asthma");
	const again = { ...result("id,name\n4471,asthma", "toolu_9"), timestamp: 99 };

	expect(keyOf(again)).toEqual(keyOf(first));
	expect(keyOf(result("id,name\n4472,asthma"))).not.toEqual(keyOf(first));
});

test("a reply retried with other thinking, another time and another account keeps its key", () => {
	const first = reply("ultra-a", [
		{ type: "thinking", thinking: "Read the file." },
		{ type: "text", text: "Reading." },
		readCall,
	]);

	const retried = {
		...reply("ent", [{ type: "thinking", thinking: "Open it first." }, { type: "text", text: "Reading." }, readCall]),
		timestamp: 50,
	};

	expect(keyOf(retried)).toEqual(keyOf(first));
	expect(keyOf(reply("ultra-a", [{ type: "text", text: "Reading now." }, readCall]))).not.toEqual(keyOf(first));
});

const Sections = Schema.Record(Schema.String, Schema.NullOr(Schema.String));

const decodeSections = Schema.decodeUnknownOption(Schema.fromJsonString(Sections));

/** Pi marks a removed section with null. */
const sectionsJson = '{"project": "<project>phi-router</project>", "removed": null}';

const sections = decodeSections(sectionsJson).pipe(Option.getOrThrow);

test("a system message gives a content part, a part per present section and a tools part", () => {
	const system: Message = {
		role: "system",
		content: "You are a coding agent.",
		sections,
		toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
		timestamp: 0,
	};

	const parts = partsOf(system);

	expect(Arr.map(parts, ({ slot }) => slot._tag)).toEqual(["SystemContent", "SystemSection", "SystemTools"]);
	expect(Arr.flatMap(parts, ({ slot }) => ("name" in slot ? [slot.name] : []))).toEqual(["project"]);
	expect(new Set(Arr.map(parts, ({ key }) => key)).size).toBe(3);
});

test("a tool result's context starts with its own tool call", () => {
	const messages = [asked("Why do admissions fail?"), reply("ultra-a", [readCall]), result("id,name\n4471,asthma")];
	const tool = piecesOf({ messages, window: 1 }).at(-1);

	expect(tool?.piece.context).toEqual(['[tool call] read({"path":"notes/admissions.csv"})']);
});

test("own content starts at the last assistant message, and replies are personal only from a personal account", () => {
	const messages = [
		asked("Why do admissions fail?"),
		reply("ent", [{ type: "text", text: "Checking." }]),
		asked("Look again."),
		reply("ultra-a", [readCall]),
		result("id,name\n4471,asthma"),
	];

	const pieces = piecesOf({ messages });

	expect(Arr.map(pieces, ({ own, piece }) => [own, piece.kind])).toEqual([
		[false, "user"],
		[false, "reply-other"],
		[false, "user"],
		[true, "reply-personal"],
		[true, "tool-result"],
	]);
});

test("a message that goes on mid-word from the last one of its role is judged with that one's end, and others are not", () => {
	const cut = result("member 4471, ssn 412-56-78");
	const sealedCut = result("member 9001, ssn 523-61-12", "toolu_3");
	const sealedKeys = new Set(keyOf(sealedCut));

	const messages = [
		asked("Read the export."),
		cut,
		result("23, plan gold", "toolu_2"),
		asked("thanks"),
		result(" next page.\n", "toolu_4"),
		sealedCut,
		result("34, plan silver", "toolu_5"),
	];

	const pieces = piecesOf({ messages, sealed: (key) => sealedKeys.has(key), window: 1 });

	expect(Arr.map(pieces, ({ piece }) => piece.seam)).toEqual(["", "", "member 4471, ssn 412-56-78", "", "", "", ""]);
});
