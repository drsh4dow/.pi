import { expect, test } from "bun:test";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Function from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";

import { bridged, phiRouter } from "./index.ts";
import { onAccount, phiModel } from "./router.fixture.ts";

const registeredFor = (ids: ReadonlyArray<string>) => {
	const registered: Array<{
		readonly provider: string;
		readonly id: string;
		readonly name: string;
		readonly thinkingLevels: unknown;
		readonly contextWindow: number | undefined;
		readonly maxTokens: number | undefined;
	}> = [];

	phiRouter({ env: { HOME: "/nonexistent" }, ids })({
		appendEntry: Function.constVoid,
		events: createEventBus(),
		on: () => Function.constVoid,
		registerCommand: Function.constVoid,
		registerVirtualModel: ({ provider, id, name, thinkingLevels, contextWindow, maxTokens }) => {
			registered.push({ provider, id, name, thinkingLevels, contextWindow, maxTokens });
		},
	});

	return registered;
};

const catalogLimits = (model: Parameters<typeof getSupportedThinkingLevels>[0]) => ({
	provider: "phi",
	thinkingLevels: getSupportedThinkingLevels(model),
	contextWindow: model.contextWindow,
	maxTokens: model.maxTokens,
});

test("phi/auto and one phi/<id> per distinct id register at load, each with its own catalog model's limits", () => {
	const registered = registeredFor(["claude-opus-5-5", "gpt-6.1-sol", "claude-opus-5-5", "glm-5.3-flash"]);

	expect(registered).toEqual([
		{ id: "auto", name: "PHI router", ...catalogLimits(getBuiltinModel("anthropic", "claude-opus-5-5")) },
		{
			id: "claude-opus-5-5",
			name: "PHI router (claude-opus-5-5)",
			...catalogLimits(getBuiltinModel("anthropic", "claude-opus-5-5")),
		},
		{
			id: "gpt-6.1-sol",
			name: "PHI router (gpt-6.1-sol)",
			...catalogLimits(getBuiltinModel("openai", "gpt-6.1-sol")),
		},
		{
			id: "glm-5.3-flash",
			name: "PHI router (glm-5.3-flash)",
			...catalogLimits(getBuiltinModel("opencode-go", "glm-5.3-flash")),
		},
	]);
});

test("an id the builtin catalog lacks registers with unknown limits and every thinking level", () => {
	const fable = Arr.findFirst(registeredFor(["claude-fable-5-2"]), ({ id }) => id === "claude-fable-5-2");

	expect(fable.pipe(Option.getOrUndefined)).toEqual({
		provider: "phi",
		id: "claude-fable-5-2",
		name: "PHI router (claude-fable-5-2)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: undefined,
		maxTokens: undefined,
	});
});

const sectionsOn = (model: ReturnType<typeof phiModel>) => {
	const sections: Record<string, string> = {};

	bridged({ event: { systemPromptOptions: { sections } }, ctx: { model } });

	return Rec.keys(sections);
};

test("the phi-bridge section goes into a session on any phi model and no other", () => {
	expect(sectionsOn(phiModel("auto"))).toEqual(["phi-bridge"]);
	expect(sectionsOn(phiModel("claude-fable-5-2"))).toEqual(["phi-bridge"]);
	expect(sectionsOn(onAccount("ultra-a"))).toEqual([]);
});
