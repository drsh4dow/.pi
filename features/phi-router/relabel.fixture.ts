import type { ClassifierResult } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { Classify } from "./decisions.ts";
import { type Lane, LaneLine } from "./lanes.ts";
import { parseLanes } from "./relabel.ts";

export const laneOf = (fields: Partial<Lane> & Pick<Lane, "session">): Lane => ({
	time: 0,
	leaf: "e1",
	reason: "user",
	mode: "shadow",
	verdict: "clean",
	wouldBe: "ultra-a",
	dispatched: "ent",
	chars: 100,
	newChars: 100,
	judgeCalls: 1,
	judgeMs: 0,
	...fields,
});

const encodeLane = Schema.encodeEffect(LaneLine);

export const laneLine = (lane: Lane) => encodeLane(lane);

export const lanesOf = (records: ReadonlyArray<Lane>) =>
	Effect.map(
		Effect.forEach(records, (lane) =>
			Effect.map(encodeLane(lane), (line) => ({ name: `${lane.session}.jsonl`, text: `${line}\n` })),
		),
		parseLanes,
	);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export interface Said {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly text: string;
}

const messageOf = ({ role, text }: Said) =>
	role === "user"
		? { role, content: text, timestamp: 0 }
		: { role, content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 };

const at = "2026-01-01T00:00:00.000Z";

export const sessionText = ({ session, turns }: { readonly session: string; readonly turns: ReadonlyArray<Said> }) => {
	const header = { type: "session", version: 3, id: session, timestamp: at, cwd: "/tmp" };

	const entries = Arr.map(turns, (said, index) => ({
		type: "message",
		id: said.id,
		parentId: Option.getOrNull(Option.map(Arr.get(turns, index - 1), ({ id }) => id)),
		timestamp: at,
		message: messageOf(said),
	}));

	return Effect.map(
		Effect.forEach([header, ...entries], (entry) => encodeJson(entry)),
		Arr.join("\n"),
	);
};

export const sessionsFrom = (files: Readonly<Record<string, string>>) => (session: string) =>
	Effect.succeed(Option.fromUndefinedOr(files[session]));

const resultOf = (fields: Pick<ClassifierResult, "answers" | "stopReason">): ClassifierResult => ({
	api: "openai-decisions",
	provider: "openai",
	model: "scripted",
	timestamp: 0,
	...fields,
});

export const scripted =
	(pPhi: (conversation: string) => Option.Option<number>): Classify =>
	(context) => {
		const { conversation } = context.state;
		const probability = pPhi(Predicate.isString(conversation) ? conversation : "");

		return Promise.resolve(
			Option.match(probability, {
				onNone: () => resultOf({ answers: { phi: { type: "bool", probability: 0 } }, stopReason: "error" }),
				onSome: (value) => resultOf({ answers: { phi: { type: "bool", probability: value } }, stopReason: "stop" }),
			}),
		);
	};
