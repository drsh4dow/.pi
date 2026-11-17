import { expect, test } from "bun:test";

import {
	type Api,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type Provider,
	type SystemMessage,
	type TranscriptContext,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createEventBus, type SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { borderEvents, borderOf } from "./border-scope.ts";
import type { BorderLink, Seal } from "./border.ts";
import { partsOf } from "./parts.ts";
import { stubs } from "./policy/policy.ts";
import { onAccount, phiModel } from "./router.fixture.ts";

const plain: SystemMessage = { role: "system", content: "You are a coding agent.", timestamp: 0 };

const asked: UserMessage = { role: "user", content: "Why does the eligibility import drop row 88123?", timestamp: 1 };

const member = "Member Rosalind Fairweather, DOB 1957-02-11";

const pasted: UserMessage = { role: "user", content: member, timestamp: 2 };

const unjudged: UserMessage = { role: "user", content: "And the row after it?", timestamp: 3 };

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];

const withTools: SystemMessage = { ...plain, toolsAdded: tools };

const glm = getBuiltinModel("opencode-go", "glm-5.3-flash");

const sol = getBuiltinModel("openai", "gpt-6.1-sol");

/** The pi openai and opencode-go providers, with stream and streamSimple that record what reaches them. */
const registryWorld = () => {
	const sent: Array<TranscriptContext> = [];

	const recorded = (_model: Model<Api>, context: TranscriptContext) => {
		sent.push(context);

		return createAssistantMessageEventStream();
	};

	const recording = (id: string): Provider => ({
		...Option.getOrThrow(Arr.findFirst(builtinProviders(), (provider) => provider.id === id)),
		stream: recorded,
		streamSimple: recorded,
	});

	const providers = new Map(Arr.map(["openai", "opencode-go"], (id) => [id, recording(id)] as const));

	return {
		sent,
		registered: (id: string) => Option.getOrThrow(Option.fromUndefinedOr(providers.get(id))),
		register: (provider: Provider) => {
			providers.set(provider.id, provider);
		},
		registry: { getProvider: (id: string) => providers.get(id) },
	};
};

type World = ReturnType<typeof registryWorld>;

const linked = (verdicts: ReadonlyArray<readonly [Message, Seal]>) => {
	const reports: Array<Parameters<BorderLink["report"]>[0]> = [];

	const known = new Map(
		Arr.flatMap(verdicts, ([message, seal]) => Arr.map(partsOf(message), ({ key }) => [key, seal])),
	);

	const link: BorderLink = {
		lookup: (key) => known.get(key),
		report: (report) => {
			reports.push(report);
		},
	};

	return { link, reports };
};

const sessionOn = ({
	model,
	world,
	branch = [],
}: {
	readonly model: ReturnType<typeof phiModel>;
	readonly world: World;
	readonly branch?: ReadonlyArray<SessionEntry>;
}) => ({ model, sessionManager: { getBranch: () => [...branch] }, modelRegistry: world.registry });

const linkedBorder = (world: World, verdicts: ReadonlyArray<readonly [Message, Seal]>) => {
	const events = createEventBus();
	const border = borderOf({ events, register: world.register });
	const { link, reports } = linked(verdicts);

	events.emit(borderEvents.link, link);

	return { border, reports };
};

const sentMessages = (world: World) => Arr.map(world.sent, ({ messages }) => messages);

/** The registry after a `phi/glm-5.3-flash` session starts, with verdicts for the system prompt and two parts. */
const protectedWorld = () => {
	const world = registryWorld();

	const { border } = linkedBorder(world, [
		[plain, "cleared"],
		[asked, "cleared"],
		[pasted, "sealed"],
	]);

	border.sessionStarted(sessionOn({ model: phiModel("glm-5.3-flash"), world }));

	return world;
};

test("in a protected session opencode-go receives stubs for sealed and unjudged parts and refuses uncleared tools", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const world = protectedWorld();
			const opencodeGo = world.registered("opencode-go");

			opencodeGo.streamSimple(glm, normalizeContext({ messages: [plain, asked, pasted] }));
			opencodeGo.stream(glm, normalizeContext({ messages: [plain, unjudged] }));

			const refused = yield* Effect.promise(() =>
				opencodeGo.stream(glm, normalizeContext({ messages: [withTools, asked] })).result(),
			);

			expect(sentMessages(world)).toEqual([
				[plain, asked, { role: "user", content: stubs.sealed, timestamp: 2 }],
				[plain, { role: "user", content: stubs.unknown, timestamp: 3 }],
			]);
			expect(refused.errorMessage).toStartWith("phi border refused:");
		}),
	));

test("in a protected session openai, a BAA provider, stays unwrapped and receives sealed parts as they are", () => {
	const world = registryWorld();
	const original = world.registered("openai");

	const { border } = linkedBorder(world, [
		[plain, "cleared"],
		[pasted, "sealed"],
	]);

	const session = sessionOn({ model: phiModel("auto"), world });

	border.sessionStarted(session);
	border.agentStarting(session);
	world.registered("openai").streamSimple(sol, normalizeContext({ messages: [plain, pasted, unjudged] }));

	expect(world.registered("openai")).toBe(original);
	expect(sentMessages(world)).toEqual([[plain, pasted, unjudged]]);
});

test("in an open session opencode-go receives the request untouched", () => {
	const world = registryWorld();
	const border = borderOf({ events: createEventBus(), register: world.register });
	const context = normalizeContext({ messages: [plain, pasted] });

	border.sessionStarted(sessionOn({ model: onAccount("ultra-a"), world }));
	world.registered("opencode-go").streamSimple(glm, context);

	expect(world.sent).toEqual([context]);
});

/** A border of a `phi/auto` session that wraps three times, and the reports of its link. */
const wrappedThrice = (world: World) => {
	const { border, reports } = linkedBorder(world, [
		[plain, "cleared"],
		[asked, "cleared"],
	]);

	const session = sessionOn({ model: phiModel("auto"), world });

	border.sessionStarted(session);
	border.sessionStarted(session);
	border.agentStarting(session);

	return reports;
};

test("wrapping again, by the same border or after a reload, leaves one guard over the original opencode-go", () => {
	const world = registryWorld();
	const reports = wrappedThrice(world);

	world.registered("opencode-go").stream(glm, normalizeContext({ messages: [plain, asked] }));

	const reloaded = borderOf({ events: createEventBus(), register: world.register });
	const context = normalizeContext({ messages: [plain, pasted] });

	reloaded.sessionStarted(sessionOn({ model: onAccount("ultra-a"), world }));
	world.registered("opencode-go").stream(glm, context);

	expect(reports).toEqual([{ stubbedSealed: 0, stubbedUnknown: 0, refused: false, account: "opencode-go" }]);
	expect(world.sent[1]).toBe(context);
});

const modelChange = (modelId: string): SessionEntry => ({
	type: "model_change",
	id: "m0000001",
	parentId: "",
	timestamp: "2026-05-14T10:00:00.000Z",
	provider: "phi",
	modelId,
});

/** What a personal Claude account receives of one request after the session starts as `start` says. */
const personalSees = (start: (border: ReturnType<typeof borderOf>, world: World) => void) => {
	const world = registryWorld();
	const border = borderOf({ events: createEventBus(), register: world.register });
	const ultraA = border.wrap("ultra-a")(world.registered("opencode-go"));

	start(border, world);
	ultraA.stream(glm, normalizeContext({ messages: [asked] }));

	return sentMessages(world);
};

const stubbed: Array<Array<Message>> = [[{ role: "user", content: stubs.unknown, timestamp: 1 }]];

test("a session is protected while its selection is a phi model", () => {
	const onFable = personalSees((border, world) => {
		border.sessionStarted(sessionOn({ model: phiModel("claude-fable-5-2"), world }));
	});

	const selectedLater = personalSees((border, world) => {
		border.sessionStarted(sessionOn({ model: onAccount("ultra-a"), world }));
		border.modelSelected(phiModel("glm-5.3-flash"));
	});

	expect([onFable, selectedLater]).toEqual([stubbed, stubbed]);
});

test("a switch away from a phi model breaks the seal: the personal account gets the request untouched", () => {
	const resumedAway = personalSees((border, world) => {
		border.sessionStarted(
			sessionOn({ model: onAccount("ultra-a"), world, branch: [modelChange("claude-fable-5-2")] }),
		);
	});

	const switchedAway = personalSees((border, world) => {
		border.sessionStarted(sessionOn({ model: phiModel("auto"), world }));
		border.modelSelected(onAccount("ultra-a"));
	});

	expect([resumedAway, switchedAway]).toEqual([[[asked]], [[asked]]]);
});

test("a session that never selected a phi model is open", () => {
	const open = personalSees((border, world) => {
		border.sessionStarted(sessionOn({ model: onAccount("ultra-a"), world }));
	});

	expect(open).toEqual([[asked]]);
});
