import { expect, test } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { guidesOf, indexOf, inContext } from "./context.ts";

const body = (name: string) =>
	Arr.makeBy(10, (line) => `Line ${String(line)} of the ${name} guide, long enough to mark it.`);

const file = (name: string, lines: ReadonlyArray<string>) =>
	`---\nname: ${name}\n---\n\n# ${name}\n\n${Arr.join(lines, "\n")}\n`;

const tdd = { kind: "skill" as const, name: "tdd", path: "/skills/tdd/SKILL.md", text: file("tdd", body("tdd")) };

const lever = {
	kind: "principle" as const,
	name: "build-the-lever",
	path: "/principles/build-the-lever.md",
	text: file("build-the-lever", body("lever")),
};

const index = () => indexOf(guidesOf([tdd, lever]));

const ask = (session: SessionManager, text: string) =>
	session.appendMessage({ role: "user", content: text, timestamp: 0 });

const toolResult = (session: SessionManager, text: string) =>
	session.appendMessage({
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	});

const loaded = (session: SessionManager) =>
	Arr.map(inContext({ index: index(), entries: session.buildSessionProjection().entries }), ({ name, state, by }) => ({
		name,
		state,
		by,
	}));

test("a guide read whole is in context, loaded by the agent", () => {
	const session = SessionManager.inMemory();
	ask(session, "fix the bug");
	toolResult(session, tdd.text);

	expect(loaded(session)).toEqual([{ name: "tdd", state: "full", by: "agent" }]);
});

test("a ranged read is partial until the rest arrives", () => {
	const session = SessionManager.inMemory();
	const lines = body("lever");
	toolResult(session, Arr.join(Arr.take(lines, 4), "\n"));

	expect(loaded(session)).toEqual([{ name: "build-the-lever", state: "partial", by: "agent" }]);

	toolResult(session, Arr.join(Arr.drop(lines, 4), "\n"));

	expect(loaded(session)).toEqual([{ name: "build-the-lever", state: "full", by: "agent" }]);
});

test("a line or two quoted from a guide does not load it", () => {
	const session = SessionManager.inMemory();
	const quoted = Arr.take(body("tdd"), 2);
	toolResult(session, Arr.join(quoted, "\n"));

	expect(loaded(session)).toEqual([]);
});

test("a /skill: expansion is loaded by the person", () => {
	const session = SessionManager.inMemory();
	ask(session, `<skill name="tdd" location="${tdd.path}">\n${tdd.text}\n</skill>\n\nadd a test`);

	expect(loaded(session)).toEqual([{ name: "tdd", state: "full", by: "person" }]);
});

test("a file returned inside a script's JSON still loads", () => {
	const session = SessionManager.inMemory();
	const escaped = Str.replaceAll("\n", String.raw`\n`)(lever.text);
	toolResult(session, `{"path":"${lever.path}","content":"${escaped}"}`);

	expect(loaded(session)).toEqual([{ name: "build-the-lever", state: "full", by: "agent" }]);
});

test("lines two guides share mark neither", () => {
	const shared = body("shared");
	const one = { ...tdd, text: file("tdd", shared) };
	const two = { ...lever, text: file("build-the-lever", shared) };
	const session = SessionManager.inMemory();
	toolResult(session, one.text);

	const sharing = indexOf(guidesOf([one, two]));

	expect(inContext({ index: sharing, entries: session.buildSessionProjection().entries })).toEqual([]);
});

test("guides keep the order they entered the context", () => {
	const session = SessionManager.inMemory();
	toolResult(session, lever.text);
	toolResult(session, tdd.text);

	expect(Arr.map(loaded(session), ({ name }) => name)).toEqual(["build-the-lever", "tdd"]);
});

test("going back in the tree to before a read drops the guide", () => {
	const session = SessionManager.inMemory();
	const before = ask(session, "first");
	toolResult(session, tdd.text);
	session.branch(before);

	expect(loaded(session)).toEqual([]);
});

test("a compaction drops the guides it summarized and keeps the ones after its cut", () => {
	const session = SessionManager.inMemory();
	toolResult(session, tdd.text);
	const kept = ask(session, "next");
	toolResult(session, lever.text);
	session.appendCompaction("Read the tdd skill.", kept, 1000);

	expect(Arr.map(loaded(session), ({ name }) => name)).toEqual(["build-the-lever"]);
});

test("a context edit that omits the read drops the guide", () => {
	const session = SessionManager.inMemory();
	const read = toolResult(session, tdd.text);
	session.appendContextEdit(read, Option.getOrNull(Option.none()));

	expect(loaded(session)).toEqual([]);
});
