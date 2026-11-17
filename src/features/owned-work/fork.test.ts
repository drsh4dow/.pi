import { expect, test } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";

import { forkPlanOf } from "./fork.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const conversation = () => {
	const session = SessionManager.inMemory("/p");

	session.appendModelChange("anthropic", "claude-opus-5-5");

	const first = session.appendMessage({ role: "user", content: "Find the bug.", timestamp: 0 });

	const reply = session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "It is in the parser." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	});

	const second = session.appendMessage({ role: "user", content: [{ type: "text", text: "Fix it." }], timestamp: 0 });

	return { session, first, reply, second };
};

test("/clone keeps the whole path to the entry and puts nothing in the editor", () => {
	const { session, second } = conversation();

	expect(forkPlanOf(session)({ entryId: second, position: "at" })).toEqual(
		Option.some({ leaf: Option.some(second), draft: Option.none() }),
	);
});

test("/fork on a later prompt keeps the path before it and puts the prompt back in the editor", () => {
	const { session, reply, second } = conversation();

	expect(forkPlanOf(session)({ entryId: second, position: "before" })).toEqual(
		Option.some({ leaf: Option.some(reply), draft: Option.some("Fix it.") }),
	);
});

test("/fork on the first prompt starts a fresh session, since the path before it holds no message", () => {
	const { session, first } = conversation();

	expect(forkPlanOf(session)({ entryId: first, position: "before" })).toEqual(
		Option.some({ leaf: Option.none(), draft: Option.some("Find the bug.") }),
	);
});

test("/fork on an entry that is not a prompt leaves the fork to pi", () => {
	const { session, reply } = conversation();

	expect(forkPlanOf(session)({ entryId: reply, position: "before" })).toEqual(Option.none());
});
