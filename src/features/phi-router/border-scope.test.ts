import { expect, test } from "bun:test";

import {
	type Api,
	type ClassifierContext,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type Provider,
	type SystemMessage,
	type TranscriptContext,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinClassifierModel, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
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

const sol = getBuiltinModel("openai", "gpt-6.1-sol");

const judgeContext: ClassifierContext = {
	state: { text: member },
	questions: {
		name: { type: "bool", instructions: "Does it name a patient?", criteria: { true: "yes", false: "no" } },
	},
};

/** The pi openai provider, with stream, streamSimple and classify that record what reaches them. */
const registryWorld = () => {
	const sent: Array<TranscriptContext> = [];
	const judged: Array<ClassifierContext> = [];
	const builtin = Option.getOrThrow(Arr.findFirst(builtinProviders(), ({ id }) => id === "openai"));

	const recorded = (_model: Model<Api>, context: TranscriptContext) => {
		sent.push(context);

		return createAssistantMessageEventStream();
	};

	const original: Provider = {
		...builtin,
		stream: recorded,
		streamSimple: recorded,
		classify: (model, context) => {
			judged.push(context);

			return Promise.resolve({
				api: model.api,
				provider: "openai",
				model: model.id,
				answers: {},
				stopReason: "stop",
				timestamp: 0,
			});
		},
	};

	const providers = new Map([["openai", original]]);

	return {
		sent,
		judged,
		registered: () => Option.getOrThrow(Option.fromUndefinedOr(providers.get("openai"))),
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

/** The registry's openai after a `phi/gpt-6.1-sol` session starts, with verdicts for the system prompt and two parts. */
const protectedOpenai = () => {
	const world = registryWorld();

	const { border } = linkedBorder(world, [
		[plain, "cleared"],
		[asked, "cleared"],
		[pasted, "sealed"],
	]);

	border.sessionStarted(sessionOn({ model: phiModel("gpt-6.1-sol"), world }));

	return { world, openai: world.registered() };
};

test("in a protected session openai receives stubs for sealed and unjudged parts and refuses uncleared tools", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { world, openai } = protectedOpenai();

			openai.streamSimple(sol, normalizeContext({ messages: [plain, asked, pasted] }));
			openai.stream(sol, normalizeContext({ messages: [plain, unjudged] }));

			const refused = yield* Effect.promise(() =>
				openai.stream(sol, normalizeContext({ messages: [withTools, asked] })).result(),
			);

			expect(sentMessages(world)).toEqual([
				[plain, asked, { role: "user", content: stubs.sealed, timestamp: 2 }],
				[plain, { role: "user", content: stubs.unknown, timestamp: 3 }],
			]);
			expect(refused.errorMessage).toStartWith("phi border refused:");
		}),
	));

test("in a protected session the Decisions judge on openai reads raw content", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { world, openai } = protectedOpenai();

			yield* Effect.promise(() =>
				Promise.resolve(openai.classify?.(getBuiltinClassifierModel("openai", "gpt-6-luna"), judgeContext)),
			);

			expect(world.judged).toEqual([judgeContext]);
		}),
	));

test("in an open session openai receives the request untouched", () => {
	const world = registryWorld();
	const border = borderOf({ events: createEventBus(), register: world.register });
	const context = normalizeContext({ messages: [plain, pasted] });

	border.sessionStarted(sessionOn({ model: onAccount("ultra-a"), world }));
	world.registered().streamSimple(sol, context);

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

test("wrapping again, by the same border or after a reload, leaves one guard over the original openai", () => {
	const world = registryWorld();
	const reports = wrappedThrice(world);

	world.registered().stream(sol, normalizeContext({ messages: [plain, asked] }));

	const reloaded = borderOf({ events: createEventBus(), register: world.register });
	const context = normalizeContext({ messages: [plain, pasted] });

	reloaded.sessionStarted(sessionOn({ model: onAccount("ultra-a"), world }));
	world.registered().stream(sol, context);

	expect(reports).toEqual([{ stubbedSealed: 0, stubbedUnknown: 0, refused: false, account: "openai" }]);
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
	const ultraA = border.wrap("ultra-a")(world.registered());

	start(border, world);
	ultraA.stream(sol, normalizeContext({ messages: [asked] }));

	return sentMessages(world);
};

const stubbed: Array<Array<Message>> = [[{ role: "user", content: stubs.unknown, timestamp: 1 }]];

test("a session on any phi model, or whose branch ever selected one, is protected", () => {
	const onFable = personalSees((border, world) => {
		border.sessionStarted(sessionOn({ model: phiModel("claude-fable-5-2"), world }));
	});

	const switchedAway = personalSees((border, world) => {
		border.sessionStarted(sessionOn({ model: onAccount("ultra-a"), world, branch: [modelChange("gpt-6.1-sol")] }));
	});

	const selectedLater = personalSees((border, world) => {
		const session = sessionOn({ model: onAccount("ultra-a"), world });

		border.sessionStarted(session);
		border.modelSelected(phiModel("glm-5.3-flash"), session);
	});

	expect([onFable, switchedAway, selectedLater]).toEqual([stubbed, stubbed, stubbed]);
});

test("a session that never selected a phi model is open", () => {
	const open = personalSees((border, world) => {
		border.sessionStarted(sessionOn({ model: onAccount("ultra-a"), world }));
	});

	expect(open).toEqual([[asked]]);
});
