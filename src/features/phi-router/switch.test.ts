import { expect, test } from "bun:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import { onAccount, phiAuto } from "./router.fixture.ts";
import { keepProtected, keepProtectedOnStart } from "./selection.ts";

const base = { id: "e1", parentId: "", timestamp: "2026-05-14T10:00:00.000Z" };

const message: SessionEntry = { ...base, type: "message", message: { role: "user", content: "hello", timestamp: 0 } };

const injected: SessionEntry = {
	...base,
	type: "custom_message",
	customType: "owned-work",
	content: "A delegate's answer.",
	display: true,
};

const compacted: SessionEntry = {
	...base,
	type: "compaction",
	summary: "We fixed the importer.",
	firstKeptEntryId: "e1",
	tokensBefore: 1000,
};

const selectedOn = (provider: string, modelId: string): SessionEntry => ({
	...base,
	type: "model_change",
	provider,
	modelId,
});

const keyOf = ({ provider, id }: Model<Api>) => `${provider}/${id}`;

const linked = (entries: ReadonlyArray<SessionEntry>) =>
	Arr.map(entries, (entry, index): SessionEntry => ({
		...entry,
		id: `e${String(index + 1)}`,
		parentId: index === 0 ? "" : `e${String(index)}`,
	}));

const piWith = (failing: ReadonlyArray<string>, branch: ReadonlyArray<SessionEntry>) => {
	const asked: Array<string> = [];
	const notices: Array<string> = [];

	const setModel = (model: Model<Api>) => {
		asked.push(keyOf(model));

		return Promise.resolve(!Arr.contains(failing, model.provider));
	};

	const ctx = {
		sessionManager: { getBranch: () => linked(branch) },
		ui: { notify: (_message: string, level?: string) => notices.push(level ?? "info") },
		modelRegistry: {
			find: (provider: string, id: string) => (provider === "phi" ? phiAuto : { ...onAccount(provider), id }),
		},
	};

	return { asked, notices, setModel, ctx };
};

const switchTo = ({
	from,
	to,
	branch,
	failing = [],
}: {
	readonly from: Model<Api>;
	readonly to: Model<Api>;
	readonly branch: ReadonlyArray<SessionEntry>;
	readonly failing?: ReadonlyArray<string>;
}) => {
	const pi = piWith(failing, branch);
	const event = { type: "model_select" as const, model: to, previousModel: from, source: "set" as const };

	return Effect.as(
		Effect.promise(() => keepProtected({ event, ctx: pi.ctx, setModel: pi.setModel })),
		pi,
	);
};

const rows = [
	{
		name: "phi/auto with messages to a personal account is put back",
		from: phiAuto,
		to: onAccount("ultra-a"),
		branch: [message],
		asked: ["phi/auto"],
	},
	{
		name: "ent with messages to a personal account is put back",
		from: onAccount("ent"),
		to: onAccount("ultra-b"),
		branch: [message],
		asked: ["ent/claude-opus-5-5"],
	},
	{ name: "phi/auto with messages to ent stands", from: phiAuto, to: onAccount("ent"), branch: [message], asked: [] },
	{
		name: "phi/auto with no messages to a personal account stands",
		from: phiAuto,
		to: onAccount("ultra-a"),
		branch: [],
		asked: [],
	},
	{
		name: "a personal account with messages to another stands",
		from: onAccount("ultra-a"),
		to: onAccount("ultra-b"),
		branch: [message],
		asked: [],
	},
	{
		name: "ent holding only an extension's message to a personal account is put back",
		from: onAccount("ent"),
		to: onAccount("ultra-a"),
		branch: [injected],
		asked: ["ent/claude-opus-5-5"],
	},
	{
		name: "phi/auto holding only a compaction summary to a personal account is put back",
		from: phiAuto,
		to: onAccount("ultra-a"),
		branch: [compacted],
		asked: ["phi/auto"],
	},
];

for (const { name, from, to, branch, asked } of rows) {
	test(`a model switch from ${name}`, () =>
		Effect.runPromise(
			Effect.map(switchTo({ from, to, branch }), (pi) => {
				expect(pi.asked).toEqual(asked);
			}),
		));
}

const switchedFromEnt = (failing: ReadonlyArray<string>) =>
	switchTo({ from: onAccount("ent"), to: onAccount("ultra-a"), branch: [message], failing });

test("when ent cannot be selected again, the session goes to phi/auto, never stays personal", () =>
	Effect.runPromise(
		Effect.map(switchedFromEnt(["ent"]), (pi) => {
			expect(pi.asked).toEqual(["ent/claude-opus-5-5", "phi/auto"]);
			expect(pi.notices).toEqual(["warning"]);
		}),
	));

test("when no protected model can be selected, the human gets an error", () =>
	Effect.runPromise(
		Effect.map(switchedFromEnt(["ent", "phi"]), (pi) => {
			expect(pi.asked).toEqual(["ent/claude-opus-5-5", "phi/auto"]);
			expect(pi.notices).toEqual(["error"]);
		}),
	));

const opus = "claude-opus-5-5";

const startOn = (branch: ReadonlyArray<SessionEntry>) => {
	const pi = piWith([], branch);
	const ctx = { ...pi.ctx, model: onAccount("ultra-a") };

	return Effect.as(
		Effect.promise(() => keepProtectedOnStart({ ctx, setModel: pi.setModel })),
		pi.asked,
	);
};

const resumedOnPersonal = [selectedOn("ent", opus), message, selectedOn("ultra-a", opus)];

const neverProtected = [selectedOn("ultra-b", opus), message];

test("a protected session resumed on a personal model goes back to its protected selection", () =>
	Effect.runPromise(
		Effect.map(startOn(resumedOnPersonal), (asked) => {
			expect(asked).toEqual(["ent/claude-opus-5-5"]);
		}),
	));

test("a session that was never protected starts on a personal model untouched", () =>
	Effect.runPromise(
		Effect.map(startOn(neverProtected), (asked) => {
			expect(asked).toEqual([]);
		}),
	));
